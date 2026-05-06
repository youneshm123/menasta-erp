@echo off
title YEX WEB
cd /d "%~dp0"
start "" http://yexweb
node server.js
