@echo off
rem Käynnistää Statsikan ilman jäävää konsoli-ikkunaa (ks. Statsikka.vbs). Konsolissa ajo: npm start
cd /d "%~dp0"
start "" wscript.exe "%~dp0Statsikka.vbs"
z