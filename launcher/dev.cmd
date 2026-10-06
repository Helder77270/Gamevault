@echo off
rem GameVault launcher - dev loop for Windows.
rem Loads MSVC via vcvars64 directly because the VS installer registry is
rem broken on some machines (vswhere finds nothing); adjust VS path if needed.

set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
rem Dev fixture card (opt-in): uncomment to always have a fake cartridge
rem inserted. Masks real SD insert/eject UX (home never shows attract mode).
rem set "GAMEVAULT_DEV_MEDIA_DIR=%~dp0dev-media"
cd /d "%~dp0"
npm run tauri dev
