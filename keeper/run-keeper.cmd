@echo off
rem Runs the Zolt Odds keeper forever, restarting it if it exits. The key is read from keeper\keeper.key into the
rem environment of this process only; it is never echoed. Log: keeper\keeper.log
rem   keeper\run-keeper.cmd            (or the scheduled task "ZoltOddsKeeper" created by the setup step)
setlocal
cd /d "%~dp0.."
set "NODE=%ZOLT_NODE%"
if "%NODE%"=="" if exist "C:\Users\Hi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE=C:\Users\Hi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if "%NODE%"=="" if exist "D:\DOWNLOD\node.exe" set "NODE=D:\DOWNLOD\node.exe"
if "%NODE%"=="" set "NODE=node"
if not exist "keeper\keeper.key" (
  echo keeper\keeper.key is missing; run: node keeper\new-keeper-key.cjs >> keeper\keeper.log
  exit /b 1
)
for /f "usebackq delims=" %%k in ("keeper\keeper.key") do set "KEEPER_PRIVATE_KEY=%%k"
:loop
echo %date% %time% starting keeper >> keeper\keeper.log
"%NODE%" keeper\odds-keeper.cjs --odds 0xac86b04d48033b2454b132eded596e0c61a5b097 --send --auto-open --interval 5 >> keeper\keeper.log 2>&1
echo %date% %time% keeper exited, restarting in 15 s >> keeper\keeper.log
timeout /t 15 /nobreak > nul
goto loop
