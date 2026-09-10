@echo off
rem Windows counterpart of run-node.sh: find a node.exe without assuming it is
rem on PATH, then run the given script with it. Claude Code and Codex start
rem hooks and MCP servers with a minimal environment, so PATH alone is not
rem enough on every machine.
rem
rem Open question (design doc windows-support §08): the plugin manifests name
rem `sh cli/run-node.sh`, which Windows cannot run, and a manifest has one
rem command line for every OS. Whether Claude Code on Windows can be pointed
rem at this file has to be checked on a real Windows install; until then this
rem launcher is verified only by invoking it directly (CI, windows-2022).
setlocal

set "NODE_EXE="
for %%I in (node.exe) do if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if defined FNM_DIR if exist "%FNM_DIR%\aliases\default\node.exe" set "NODE_EXE=%FNM_DIR%\aliases\default\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo starmemory: could not find node.exe ^(looked on PATH, Program Files, nvm-windows, fnm, LocalAppData^) 1>&2
  exit /b 127
)

"%NODE_EXE%" %*
exit /b %ERRORLEVEL%
