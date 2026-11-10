# claude-statusline

A custom [Claude Code](https://claude.com/claude-code) status line. One script, no dependencies beyond Node.js.

```
🧠 ▓░░░░░░░░░ 6% 57k/1M │ 💰 $0.49 │ ⚡ 5h 6% (2h 36m) · 7d 54% │ 🤖 Opus 5.5 │ 📁 my-project │ 🌿 main*
```

| Section | Shows |
|---|---|
| 🧠 | Context window usage: bar, percentage, tokens used / window size |
| 💰 | Session cost in USD |
| ⚡ | Plan rate limits: 5-hour window (with time to reset) and 7-day window. Subscription plans only |
| 🤖 | Model name |
| 📁 | Current directory |
| 🌿 | Git branch, with `*` when there are uncommitted changes |

Sections with missing data are hidden. Context and rate limits turn yellow at 50% and red at 80%.

## Install

1. Clone the repo and make sure the script is executable:

   ```sh
   git clone git@github.com:brahmed/claude-statusline.git
   chmod +x claude-statusline/statusline.js
   ```

2. Add this to your Claude Code `settings.json` (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` if you set that), using the absolute path to the script:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "/absolute/path/to/claude-statusline/statusline.js"
     }
   }
   ```

3. Restart Claude Code.

## Customize

Thresholds, bar width and the git timeout are constants at the top of `statusline.js`.

## Test it

Claude Code pipes session JSON to the script on stdin. You can try it by hand:

```sh
echo '{"model":{"display_name":"Test"},"cwd":"'"$PWD"'"}' | ./statusline.js
```
