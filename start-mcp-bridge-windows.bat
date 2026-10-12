@echo off
REM Double-click launcher for mcp_bridge.py on Windows.
REM
REM Starts the MCP bridge that lets ollama-chat.html use the MCP servers listed
REM in mcp_servers.json (e.g. Roblox Studio's built-in one). Needs only Python.
REM Keep this window open while you use the chat app; closing it stops the bridge
REM and the MCP servers it launched.

echo ================================================================
echo  MCP bridge for ollama-chat.html
echo  It only listens on your own computer (127.0.0.1).
echo  Keep this window open while you chat.
echo ================================================================
echo.

REM Run from this file's own folder so mcp_bridge.py and mcp_servers.json
REM are always found, wherever it was double-clicked from.
cd /d "%~dp0"

set "PYCMD="
where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (
    where py >nul 2>nul && set "PYCMD=py -3"
)

if not defined PYCMD (
    echo.
    echo Couldn't find Python on this computer.
    echo Install it from https://www.python.org/downloads/
    echo IMPORTANT: on the first setup screen, check "Add python.exe to PATH".
    echo Then double-click this file again.
    echo.
    goto :end
)

%PYCMD% mcp_bridge.py 8766

:end
pause