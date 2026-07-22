; ============================================================
; DesktopMonitor Agent Inno Setup 安装脚本
;
; 生成安装包：DesktopMonitorAgent-Setup.exe
; 支持 Win10 (10.0.19041+) 与 Win11
; 包含自定义「服务器配置」页面，动态生成 config.env
; 升级安装保留 config.env 与 %PROGRAMDATA% 数据目录
; ============================================================

[Setup]
AppName=DesktopMonitor Agent
AppVersion=1.0.0
DefaultDirName={autopf}\DesktopMonitorAgent
DefaultGroupName=DesktopMonitor Agent
OutputBaseFilename=DesktopMonitorAgent-Setup
Compression=lzma2
SolidCompression=yes
; 仅在 64 位系统上以 64 位模式安装
ArchitecturesInstallIn64Bit=x64compatible
ArchitecturesAllowed=x64compatible
; Win10 2004 (10.0.19041) 及以上
MinVersion=10.0.19041
; 写入 Program Files 需要管理员权限
PrivilegesRequired=admin
UninstallDisplayIcon={app}\DesktopMonitorAgent.exe
; 输出到 agent/dist/（脚本位于 agent/build/，故用 ..\dist）
OutputDir=..\dist

[Files]
; 主程序（不包含 config.env，由脚本动态生成）
Source: "..\dist\DesktopMonitorAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; 数据目录位于 %PROGRAMDATA%，卸载时不删除（保留采集数据与凭证）
Name: "{commonappdata}\DesktopMonitorAgent\data"; Flags: uninsneveruninstall
Name: "{commonappdata}\DesktopMonitorAgent\data\screenshots"; Flags: uninsneveruninstall

[Registry]
; 开机自启（HKCU 当前用户，卸载时清理）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DesktopMonitorAgent"; ValueData: """{app}\DesktopMonitorAgent.exe"""; Flags: uninsdeletevalue

[Run]
; 安装后启动 Agent（静默安装时跳过）
Filename: "{app}\DesktopMonitorAgent.exe"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 备用：文件删除后再次尝试 kill（主流程已在 CurUninstallStepChanged 中提前处理）
Filename: "{cmd}"; Parameters: "/c taskkill /f /im DesktopMonitorAgent.exe"; Flags: runhidden; RunOnceId: "KillAgent"

[UninstallDelete]
; 清理日志文件（数据目录已用 uninsneveruninstall 标记，不会被删除）
Type: files; Name: "{app}\*.log"

[Code]
var
  ServerConfigPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  // 在「选择目录」页之后插入「服务器配置」页
  ServerConfigPage := CreateInputQueryPage(wpSelectDir,
    '服务器配置', '请填写监控服务器信息',
    'Agent 将连接到此服务器进行注册与上报，安装后可在 config.env 中修改');
  ServerConfigPage.Add('服务器 IP:', False);
  ServerConfigPage.Add('端口:', False);
  ServerConfigPage.Add('注册 Token:', False);
  ServerConfigPage.Values[0] := '127.0.0.1';
  ServerConfigPage.Values[1] := '3000';
  ServerConfigPage.Values[2] := 'change-me-please';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigFile: String;
  ConfigContent: String;
begin
  if CurStep = ssPostInstall then
  begin
    ConfigFile := ExpandConstant('{app}\config.env');
    // 仅在文件不存在时写入（升级安装保留原配置）
    if not FileExists(ConfigFile) then
    begin
      ConfigContent := 'SERVER_URL=http://' + ServerConfigPage.Values[0] + ':' + ServerConfigPage.Values[1] + #13#10 + 'AGENT_REGISTER_TOKEN=' + ServerConfigPage.Values[2] + #13#10;
      SaveStringToFile(ConfigFile, ConfigContent, False);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ErrorCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // 卸载开始前停止 Agent 进程（确保 exe 文件可被删除）
    Exec(ExpandConstant('{cmd}'), '/c taskkill /f /im DesktopMonitorAgent.exe', '', SW_HIDE, ewNoWait, ErrorCode);
  end;
end;
