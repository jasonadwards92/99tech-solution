# Problem 3 — Diagnose Me Doctor

## What's going on

We've got an Ubuntu 24.04 VM with a 64GB disk that's 99% full. The only thing running on this box is NGINX — acting as a load balancer. NGINX by itself is tiny: a binary, some config files, maybe a few log files. So clearly something else is eating all the space.

Let's figure out what.

---

## First — see how bad it is

```bash
df -h
```

This gives us disk usage per mount point. We want to know *which* filesystem hit 99%. - This is just example output, the actual output will be different.

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        63G   62G  800M  99% /
```

Yep, the root partition is basically full. 800MB left. Let's start digging.

---

## Track down where the space went

```bash
du -h --max-depth=1 / 2>/dev/null | sort -rh | head -20
```

This walks each top-level directory and sorts them biggest-first. The `2>/dev/null` just suppresses "permission denied" noise so we can focus on what matters.

On an NGINX-only box, here's what I'd expect vs. what would raise an eyebrow:

| Directory | Normal | Suspicious |
|-----------|--------|------------|
| `/var/log` | A few hundred MB | Multiple GB — logs aren't being rotated |
| `/var/lib` | Small | Large — could be old packages, snapd cache, leftover Docker stuff |
| `/tmp` | Nearly empty | Huge — something's dumping temp files |
| `/snap` | A few GB if snapd is present | Way too big — old snap revisions piling up |
| `/home` | Small | Someone left big files lying around |

Once we spot which directory is bloated, we drill deeper:

```bash
du -h --max-depth=1 /var/log | sort -rh | head -10
```

---

## Check the usual suspects

### NGINX logs — the #1 culprit

```bash
ls -lhS /var/log/nginx/
```

The `-S` flag sorts by file size, biggest first. If `access.log` is sitting there at 20~40GB+, mystery solved.

This happens more often than people think. NGINX logs every single request that passes through it. A load balancer handling even moderate traffic — say 100 requests/second — generates roughly 15-20 MB of logs per hour. That's about 400-500 MB a day, around 15 GB a month. If nobody set up log rotation, a few months is all it takes to fill a 64GB disk.

Quick check — is logrotate even configured for NGINX?

```bash
cat /etc/logrotate.d/nginx
```

If that file is missing or misconfigured, we've found our root cause.

### System logs — the quiet hoarder

```bash
journalctl --disk-usage
```

The systemd journal can silently eat up gigabytes if nobody put a size cap on it. Ubuntu 24.04 defaults to persistent journal storage, and without a limit set, it just keeps growing.

```bash
ls -lhS /var/log/syslog* /var/log/kern.log* /var/log/auth.log*
```

Same story — without logrotate doing its job, these grow indefinitely.

### Old package cache

```bash
du -sh /var/cache/apt/archives/
```

Every time someone runs `apt update && apt upgrade`, the old `.deb` files stick around here. After enough update cycles, this can add up.

### Snap packages — Ubuntu's little surprise

```bash
snap list --all | grep disabled
```

Ubuntu keeps old snap revisions around by default. Each revision is basically a full copy of the snap. On a server that's been running for a while, this can quietly waste several GB without anyone noticing.

### Deleted files still eating space — the sneaky one

This one catches people off guard. A file can be deleted from the filesystem (`rm`'d), but if a process still has it open, the space doesn't actually get freed. The kernel keeps the data around until the last file handle is closed.

```bash
lsof +L1
```

This finds files with a link count of zero — meaning they've been "deleted" but are still held open by some process. If you see a massive deleted NGINX log file still pinned by an NGINX worker process, that's your ghost eating all the disk.

---

## What's most likely happening here

**On an NGINX load balancer, it's almost always unrotated logs.** I have met this case many times.

The math is simple:
- NGINX logs every proxied request to `access.log` by default
- 100 req/s ≈ 15-20 MB/hour of logs
- That's ~400-500 MB/day, ~15 GB/month
- A few months without rotation → 64GB disk is done

Runner-up: systemd journal logs, especially on Ubuntu 24.04 where journald defaults to persistent storage with no size limit configured.

---

## Fix it

### Right now — get some breathing room

If it's NGINX logs:

```bash
# truncate in-place — don't rm!
truncate -s 0 /var/log/nginx/access.log
truncate -s 0 /var/log/nginx/error.log
```

**Important:** we use `truncate`, not `rm`. Why? Because NGINX has the file open. If you `rm` it, the inode stays allocated until NGINX releases the file handle — you'll see the disk space unchanged and wonder what went wrong. That's the exact "deleted but held open" problem from above. Truncating zeroes out the file while keeping the same file descriptor, so NGINX doesn't even flinch.

If it's journal logs:

```bash
journalctl --vacuum-size=500M
```

If it's the apt cache:

```bash
apt clean
```

If it's deleted-but-open files that you can't truncate:

```bash
# tell NGINX to reopen its log files — this releases the old, deleted ones
nginx -s reopen
```

### For good — prevent this from happening again

**Set up proper log rotation:**

```bash
cat > /etc/logrotate.d/nginx << 'EOF'
/var/log/nginx/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}
EOF
```

This rotates daily, keeps 7 days of compressed history, and — crucially — sends `USR1` to NGINX after rotation. That signal tells NGINX to gracefully close the old log and open a fresh one. Without it, NGINX would keep writing to the rotated file.

**Put a cap on journald:**

```bash
# In /etc/systemd/journald.conf, set:
# SystemMaxUse=500M

systemctl restart systemd-journald
```

**Set up an alert so you catch this early next time:**

```bash
# cron job that checks every 6 hours
echo '0 */6 * * * root [ $(df / --output=pcent | tail -1 | tr -d " %") -gt 80 ] && echo "Disk usage above 80% on $(hostname)" | mail -s "Disk Alert" ops@company.com' > /etc/cron.d/disk-alert
```

Or better — if you've already got Prometheus and Grafana running, just set an alert on `node_filesystem_avail_bytes`. That's the proper way to do it.

---

## Confirm everything worked

```bash
df -h /
```

Make sure usage actually dropped. Then check back the next day:

```bash
ls -lh /var/log/nginx/
```

You should see `access.log`, `access.log.1`, `access.log.2.gz`, etc. That means logrotate kicked in and is doing what it's supposed to.

---

## Quick reference

| What to do | Command | Why |
|---|---|---|
| Check disk usage | `df -h` | See which filesystem is full |
| Find biggest directories | `du -h --max-depth=1 / \| sort -rh \| head -20` | Narrow it down |
| Check NGINX logs | `ls -lhS /var/log/nginx/` | Most likely culprit |
| Check journal size | `journalctl --disk-usage` | Silent space hog |
| Check apt cache | `du -sh /var/cache/apt/archives/` | Old .deb files piling up |
| Find ghost files | `lsof +L1` | Deleted files still using space |
| Free space now | `truncate -s 0 /var/log/nginx/access.log` | Immediate relief |
| Prevent recurrence | Configure `/etc/logrotate.d/nginx` | Proper long-term fix |
| Verify | `df -h /` | Confirm it worked |

## Time to handle this
`10-15 mins`
