# Problem 1

## Command

```bash
grep '"TSLA"' ./transaction-log.txt | grep '"sell"' | sed -E 's/.*"order_id": "([^"]+)".*/\1/' | xargs -I{} curl -s "https://example.com/api/{}" >> ./output.txt
```

## How it works

- First `grep` filters lines containing `"TSLA"`
- Second `grep` narrows down to only sell orders (as I understand, the endpoint `https://example.com/api/:order_id` is for getting `order` details, so I need to filter sell orders first)
- `sed -E` extracts the order_id value using a capture group — matches the whole line and replaces it with just the ID
- `xargs -I{}` takes each order_id and substitutes it into the curl command
- Output appends to `./output.txt`

## Time to handle this
`10-15 mins`


## Concerns
- The endpoint `https://example.com/api/:order_id` is not have any authentication, I assume it should have some authentication (e.g. API key, Bearer token, etc.)