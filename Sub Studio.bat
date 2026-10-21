@echo off
rem Opens Sub Studio in its own window. Errors go to sub-studio\sub-studio.log
rem Old browser mode: python sub-studio\server.py --browser
start "" pythonw "%~dp0sub-studio\server.py"
