@echo off
rem GameVault - lance tout l'environnement de dev (3 fenetres) :
rem   - ticketd   : http://localhost:8787  (emission des tickets)
rem   - web       : http://localhost:3000  (marketplace + /pair + /trade)
rem   - launcher  : fenetre Tauri (compile ~1 min au premier lancement)
rem Fermer une fenetre (ou Ctrl+C dedans) arrete le service correspondant.

start "GameVault - ticketd :8787" cmd /k "cd /d %~dp0 && npm run dev -w ticketd"
start "GameVault - web :3000" cmd /k "cd /d %~dp0 && npm run dev -w web"
start "GameVault - launcher" cmd /k "call "%~dp0launcher\dev.cmd""

echo Les trois services demarrent dans leurs fenetres. Ce terminal peut etre ferme.

