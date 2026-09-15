@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
	python start.py %*
	pause
	exit /b
)
where py >nul 2>nul
if %errorlevel%==0 (
	py -3 start.py %*
	pause
	exit /b
)
echo Python 3 is required. Install it from https://www.python.org/downloads/
pause
