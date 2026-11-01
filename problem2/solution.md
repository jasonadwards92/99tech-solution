# Problem 2: Diagnose Me Doctor

## What's going on

An Ubuntu 24.04 VM with a 64GB disk is at 99% storage, and its only job is to run NGINX as a load balancer. NGINX itself needs a few megabytes, so something around it is filling the disk. On a box like this it's almost always one of five things: unrotated logs, deleted log files NGINX still holds open, an uncapped proxy cache, OS leftovers, or an Ubuntu installer quirk that only gave the root filesystem half the disk.

My order of work is: free a little space so traffic stops failing, find the cause, fix it, then add guardrails so it doesn't page anyone again.

## Why 99% already hurts

- Large requests start failing. NGINX buffers upstream responses that don't fit in memory to temp files under `/var/lib/nginx/proxy` (up to 1GB each by default), and large uploads go to `/var/lib/nginx/body`. When those writes fail, large uploads get `500` and large responses arrive truncated or reset, while small JSON calls still work, so it looks like a flaky upstream.
- Logging stops at 100%. NGINX workers run as `www-data` and `rsyslog` as `syslog`, so neither can use the 5% that ext4 reserves for root; they fail first, and the evidence disappears exactly when it's needed.
- The box gets harder to fix. `apt`, config reloads and anything writing to `/var` can fail halfway, and once root's 5% ext4 reserve is gone too, even SSH logins can hang.

## Step 1: Triage (first 5 minutes)

```bash
df -h          # Which mount is full?
df -i          # Out of bytes, or out of inodes?
lsblk          # Does the root filesystem actually use all 64GB?
tail -n 50 /var/log/nginx/error.log   # Is NGINX already failing with "No space left on device"?
```

Out of inodes gives the same `No space left on device` error as out of bytes, so I always check both. If the root filesystem shows about `30G` on a 64GB disk, that's the LVM quirk in cause 5 below.

If NGINX is already dropping traffic, I free a few hundred MB with something harmless first (`sudo apt-get clean`, `sudo journalctl --vacuum-size=200M`, or truncating an old rotated log), then investigate.

## Step 2: Find where the space went

```bash
sudo du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -20   # -x stays on this filesystem
sudo find / -xdev -type f -size +1G -exec ls -lh {} + 2>/dev/null
sudo lsof +L1                                                   # deleted files still held open
```

If `du` adds up to far less than `df` reports as used, the space is in deleted files that a running process (almost certainly NGINX) still holds open, and `lsof +L1` shows them as `(deleted)`.

For an inode problem, find the directory with millions of files:

```bash
sudo find / -xdev -type f 2>/dev/null | cut -d/ -f2-4 | sort | uniq -c | sort -rn | head -10
```

## Step 3: Causes and fixes

In rough order of likelihood:

| # | Cause | How to confirm | Fix now (no downtime) | Permanent fix |
|---|---|---|---|---|
| 1 | NGINX logs not rotated, `logrotate` failing, or `error_log ... debug` left on | `ls -lhS /var/log/nginx/`; `systemctl status logrotate.service`; `grep -rn error_log /etc/nginx/` | `sudo truncate -s 0` the big log; set `error_log` back to the default (`error`) and `sudo nginx -t && sudo systemctl reload nginx` | Size-based rotation (below); alert on a failed `logrotate.service` |
| 2 | Log deleted with `rm` while NGINX still has it open | `lsof +L1` shows `nginx` holding `access.log (deleted)` | `sudo nginx -s reopen` (sends `USR1`; no dropped connections) | Never `rm` live logs; `postrotate` must signal NGINX |
| 3 | Uncapped `proxy_cache` or stuck temp files (can also exhaust inodes) | `sudo du -sh /var/cache/nginx /var/lib/nginx/*`; `proxy_cache_path` has no `max_size` | `sudo find /var/cache/nginx -type f -mtime +1 -delete` | `max_size=5g inactive=7d` on `proxy_cache_path` |
| 4 | OS growth: `syslog`, journal, crash dumps, old kernels and packages | `journalctl --disk-usage`; `ls -lhS /var/log/syslog* /var/crash`; `du -sh /var/cache/apt/archives`; old kernels filling `/boot` (`dpkg -l 'linux-image-*'`) | `sudo journalctl --vacuum-size=500M`; `sudo apt-get autoremove --purge -y && sudo apt-get clean`; keep one crash dump, delete the rest | Fix the noisy or crashing service; `SystemMaxUse=500M` in `journald.conf` |
| 5 | Ubuntu's guided LVM install gave root only half the disk | `sudo vgs` shows ~30GB in `VFree` | `sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv` (online resize) | Fix the VM template so root uses the whole volume group |

Notes on the table:

- A busy load balancer writes a lot of logs. At 100 requests per second that's about 8.6 million access-log lines a day, roughly 1.7GB at 200 bytes a line, and debug-level error logs can fill tens of GB in hours. A 25GB `access.log` with no `.1` or `.gz` files beside it means rotation isn't happening. Check the nginx stanza in `/etc/logrotate.d/`, whether NGINX logs to a path that stanza doesn't match, and whether `logrotate.timer` is enabled. `sudo logrotate -d /etc/logrotate.conf` shows config errors (a broken stanza elsewhere marks `logrotate.service` failed but doesn't stop the others). Once it's fixed, `sudo logrotate -f /etc/logrotate.d/nginx` rotates the NGINX logs immediately.
- Use `truncate`, not `rm`, on a live log. It keeps the same inode, so NGINX keeps writing and the space comes back immediately. If you need the recent traffic, copy it out first with `tail -n 100000 access.log > /tmp/access.log.recent`.
- `rsyslog` has no size cap of its own, while `journald` caps itself at 10% of the filesystem (4GB at most). A crash-looping daemon can fill `syslog` between two daily rotations.
- The LVM quirk applies to VMs built from the Ubuntu Server ISO with the default guided layout: when the volume group is between 20 and 200 GiB, the installer gives root exactly half and leaves the rest in `VFree` (subiquity's `scaled_rootfs_size`). Cloud images don't do this. Extending the volume only buys time if logs are the real cause, because they'll fill the extra 30GB too.

## Step 4: Stop it from happening again

Rotate by size as well as by day, so a traffic spike can't produce 30GB between two daily runs:

```bash
sudo tee /etc/logrotate.d/nginx > /dev/null << 'EOF'
/var/log/nginx/*.log {
    daily
    maxsize 1G
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /run/nginx.pid ] && kill -USR1 "$(cat /run/nginx.pid)" || true
    endscript
}
EOF
sudo logrotate -d /etc/logrotate.d/nginx
```

`maxsize` is only checked when `logrotate` runs, so make the timer hourly with `sudo systemctl edit logrotate.timer`. The drop-in needs the section header, or systemd ignores it, and the empty `OnCalendar=` clears the daily schedule:

```ini
[Timer]
OnCalendar=
OnCalendar=hourly
AccuracySec=1m
```

This overwrites the packaged `/etc/logrotate.d/nginx`, so the next nginx upgrade will ask whether to keep it; keep the local version. Also cap the journal (`SystemMaxUse=500M` in `/etc/systemd/journald.conf`, then `sudo systemctl restart systemd-journald`) and give any `proxy_cache_path` a `max_size`.

Alert well before 99%, using `node_exporter` or the CloudWatch agent:

- Warning at 80% and critical at 90%, for both bytes and inodes.
- A trend alert (with `for: 30m` so it doesn't flap), which catches a forgotten debug log within hours:
  ```promql
  predict_linear(node_filesystem_avail_bytes{mountpoint="/", fstype!~"tmpfs|overlay"}[6h], 24 * 3600) < 0
  ```
- `logrotate.service` in the failed state: `node_systemd_unit_state{name="logrotate.service", state="failed"} == 1` (needs node_exporter's `--collector.systemd`).

Longer term, ship logs off the box (Vector or Fluent Bit to Loki or CloudWatch) and keep only a few days locally, put `/var/log` on its own volume so a log flood can't fill root, and replace this hand-maintained single VM with a managed load balancer (ALB/NLB) or a pair of immutable NGINX instances.

## Step 5: Verify

```bash
df -h / && df -i /                                  # Free bytes and inodes
sudo lsof +L1 | grep nginx                          # No deleted files held open
sudo nginx -t && systemctl status nginx --no-pager  # Config valid, service running
sudo tail -n 5 /var/log/nginx/access.log            # New lines are being written
```

Then I send a few requests through the load balancer, including one with a large payload, and check they return `200`. The next morning I check `/var/lib/logrotate/status` for a fresh rotation.
