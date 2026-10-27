' Käynnistää Statsikan ilman konsoli-ikkunaa (scripts\start.js: ow-electron, varalla tavallinen Electron).
' Konsoli-ikkuna sulkisi sovelluksen mukanaan, mikä ei sovi taustatilaan (ilmaisinalue).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node scripts\start.js", 0, False
