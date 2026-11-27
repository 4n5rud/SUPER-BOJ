#define ExtensionId GetEnv("SUPER_BOJ_STORE_EXTENSION_ID")
#define CoreBinary GetEnv("SUPER_BOJ_CORE_BINARY")
#define OutputDirectory GetEnv("SUPER_BOJ_INSTALLER_OUTPUT")
#define CoreVersion GetEnv("SUPER_BOJ_CORE_VERSION")

[Setup]
AppId=com.superboj.core
AppName=SUPER_BOJ Core
AppVersion={#CoreVersion}
DefaultDirName={localappdata}\Programs\SUPER_BOJ
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir={#OutputDirectory}
OutputBaseFilename=super-boj-setup-windows-x86_64

[Files]
Source: "{#CoreBinary}"; DestDir: "{app}"; DestName: "super-boj-core.exe"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.superboj.core"; ValueType: string; ValueName: ""; ValueData: "{app}\com.superboj.core.json"; Flags: uninsdeletevalue uninsdeletekeyifempty

[UninstallDelete]
Type: files; Name: "{app}\com.superboj.core.json"

[Code]
procedure CurStepChanged(Step: TSetupStep);
var
  Manifest: AnsiString;
begin
  if Step = ssPostInstall then
  begin
    Manifest := '{"name":"com.superboj.core","description":"SUPER_BOJ Local Native Engine",' +
      '"path":"super-boj-core.exe","type":"stdio",' +
      '"allowed_origins":["chrome-extension://{#ExtensionId}/"]}';
    if not SaveStringToFile(ExpandConstant('{app}\com.superboj.core.json'), Manifest, False) then
      RaiseException('Failed to write the Chrome Native Messaging manifest.');
  end;
end;
