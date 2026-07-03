#!/bin/bash
# Double-click launcher for local_cors_proxy.py on macOS. A .command file is
# a shell script Finder runs in Terminal on double-click; this just runs the
# .py the same as by hand.
#
# Published by: Mika Halbauer  (https://github.com/Yungsaas)
#
# First time only: Gatekeeper blocks double-clicking downloaded scripts.
# Right-click (or Control-click) this file, choose "Open", and confirm the
# dialog; after that, double-clicking works normally.
#
# Keep the window open while you use the chat app -- closing it (or letting
# it idle out) stops the proxy.

echo "================================================================"
echo " Published by: Mika Halbauer  (https://github.com/Yungsaas)"
echo " This window is: a local proxy for ollama-chat.html"
echo " It only talks to your own computer and the sites the chat"
echo " app asks it to fetch. Keep this window open while you chat."
echo "================================================================"
echo ""

# Run from this file's own folder so local_cors_proxy.py is always found,
# wherever it was double-clicked from.
cd "$(dirname "$0")"

# macOS has shipped python3 since Catalina (2019), so this should just work
# with nothing extra to install on any current Mac.
if command -v python3 >/dev/null 2>&1; then
    # Ask how long the proxy should wait before auto-stopping. Blank = 30 min,
    # 0 = never stop. Re-prompts until a whole number of minutes is entered.
    while true; do
        read -r -p "Enter timeout in minutes (0 to disable), or press Enter for 30: " TIMEOUT
        [ -z "$TIMEOUT" ] && TIMEOUT=30
        case "$TIMEOUT" in
            *[!0-9]*) echo "  Please enter a whole number of minutes, or 0 to disable."; echo "" ;;
            *) break ;;
        esac
    done
    echo ""
    python3 local_cors_proxy.py 8765 "$TIMEOUT"
else
    echo ""
    echo "Couldn't find Python 3 on this Mac."
    echo "Install it from https://www.python.org/downloads/"
    echo "Then double-click this file again."
    echo ""
fi

# Keep the window open after the proxy stops so any final message stays
# readable instead of the window closing instantly.
echo ""
read -n 1 -s -r -p "Press any key to close this window..."
echo ""
