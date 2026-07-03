@echo off
REM Double-click launcher for local_cors_proxy.py on Windows.
REM
REM Published by: Mika Halbauer  (https://github.com/Yungsaas)
REM
REM Starts the same proxy you'd otherwise run by hand; needs only Python.
REM Keep the window open while you use the chat app -- closing it (or letting
REM it idle out) stops the proxy.

echo ================================================================
echo  Published by: Mika Halbauer  (https://github.com/Yungsaas)
echo  This window is: a local proxy for ollama-chat.html
echo  It only talks to your own computer and the sites the chat
echo  app asks it to fetch. Keep this window open while you chat.
echo ================================================================
echo.

REM Run from this file's own folder so local_cors_proxy.py is always found,
REM wherever it was double-clicked from.
cd /d "%~dp0"

REM Windows may expose Python as "python" or only via the "py" launcher,
REM depending on how it was installed -- use whichever exists.
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

REM Ask how long the proxy should wait before auto-stopping. Blank = 30 min,
REM 0 = never stop. Re-prompts until a whole number of minutes is entered.
:askTimeout
set "TIMEOUT="
set /p "TIMEOUT=Enter timeout in minutes (0 to disable), or press Enter for 30: "
if not defined TIMEOUT set "TIMEOUT=30"
echo %TIMEOUT%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo   Please enter a whole number of minutes, or 0 to disable.
    echo.
    goto askTimeout
)
echo.

%PYCMD% local_cors_proxy.py 8765 %TIMEOUT%

:end
REM Keep the window open after the proxy stops so any final message stays
REM visible instead of the window vanishing instantly.
pause
