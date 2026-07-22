@echo off
setlocal

REM 切换到 agent/build/ 目录（脚本所在目录）
cd /d "%~dp0"

REM 读取版本号（环境变量 AGENT_VERSION，默认 1.0.0）
if not defined AGENT_VERSION set AGENT_VERSION=1.0.0

REM 将版本号写入 ../src/version.txt（覆盖写入）
(echo %AGENT_VERSION%) > "..\src\version.txt"

REM 调用 PyInstaller 打包（单文件模式，无控制台窗口）
pyinstaller agent.spec --distpath ..\dist --workpath ..\build_tmp --noconfirm

echo Build complete: agent/dist/DesktopMonitorAgent.exe

endlocal
