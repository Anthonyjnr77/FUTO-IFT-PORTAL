@echo off
cd /d "%~dp0backend"
if not exist node_modules echo This backend has no external dependencies.
node server.js
pause
