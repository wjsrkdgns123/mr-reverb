<# : MR 송출기 자동 설정 (배치 + PowerShell 한 파일)
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ((Get-Content -LiteralPath $f -Encoding UTF8) -join [char]10)"
pause
exit /b
#>

# MR 리버브 송출기 - Windows 자동 설정
#  1) 노래 모드: 송출 장치(CABLE Output, 없으면 스테레오 믹스)를 "기본 통신 장치"로, [통신] 탭을 "아무 작업도 안 함"으로
#  2) 원래대로: 1) 하기 전 설정으로 되돌림
# 오버워치에서는 "음성 대화 장치"만 직접 바꾸면 됩니다 (노래: 대화 장치 / 평소: 기본 장치).

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MrAudio {
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    void GetCount(out int count);
    void Item(int index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    void OpenPropertyStore(int access, out IPropertyStore store);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out int state);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out int count);
    void GetAt(int index, out PropKey key);
    void GetValue(ref PropKey key, out PropVariant value);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PropVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  // Undocumented but long-stable interface used by the Windows sound control panel to set defaults.
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    void GetMixFormat(); void GetDeviceFormat(); void ResetDeviceFormat(); void SetDeviceFormat();
    void GetProcessingPeriod(); void SetProcessingPeriod(); void GetShareMode(); void SetShareMode();
    void GetPropertyValue(); void SetPropertyValue();
    void SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
  }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}

  public class Device { public string Id; public string Name; public int State; }

  public static class Audio {
    const int Capture = 1;
    static IMMDeviceEnumerator E() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorCom(); }

    static string Name(IMMDevice d) {
      IPropertyStore ps; d.OpenPropertyStore(0, out ps);
      var key = new PropKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PropVariant v; ps.GetValue(ref key, out v);
      return v.p == IntPtr.Zero ? "" : Marshal.PtrToStringUni(v.p);
    }

    // stateMask 0xF = active, disabled, not present, unplugged
    public static List<Device> CaptureDevices() {
      IMMDeviceCollection c; E().EnumAudioEndpoints(Capture, 0xF, out c);
      int n; c.GetCount(out n);
      var list = new List<Device>();
      for (int i = 0; i < n; i++) {
        IMMDevice d; c.Item(i, out d);
        string id; d.GetId(out id); int st; d.GetState(out st);
        list.Add(new Device { Id = id, Name = Name(d), State = st });
      }
      return list;
    }

    // role: 0 = 기본 장치(console), 2 = 기본 통신 장치(communications)
    public static string DefaultCapture(int role) {
      try { IMMDevice d; E().GetDefaultAudioEndpoint(Capture, role, out d); string id; d.GetId(out id); return id; }
      catch { return null; }
    }

    public static void SetDefault(string id, int role) {
      ((IPolicyConfig)new PolicyConfigClient()).SetDefaultEndpoint(id, role);
    }
  }
}
'@

$StateDir = Join-Path $env:APPDATA 'MR-Reverb'
$SaveFile = Join-Path $StateDir 'before-setup.json'
$DuckKey = 'HKCU:\Software\Microsoft\Multimedia\Audio'
$Active = 1; $Disabled = 2

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function NameOf($id) { ([MrAudio.Audio]::CaptureDevices() | Where-Object Id -eq $id | Select-Object -First 1).Name }

function Sing {
  $devs = [MrAudio.Audio]::CaptureDevices()
  $target = $devs | Where-Object { $_.State -eq $Active -and $_.Name -match 'CABLE Output' } | Select-Object -First 1
  if (-not $target) { $target = $devs | Where-Object { $_.State -eq $Active -and $_.Name -match 'Stereo Mix|스테레오 믹스' } | Select-Object -First 1 }

  if (-not $target) {
    $off = $devs | Where-Object { $_.State -eq $Disabled -and $_.Name -match 'Stereo Mix|스테레오 믹스' } | Select-Object -First 1
    if ($off) {
      Say '스테레오 믹스가 꺼져 있어요. [녹음] 탭을 열게요.' Yellow
      Say '  → 빈 곳 우클릭 "사용 안 함 장치 표시" → "스테레오 믹스" 우클릭 → 사용 → 확인' Yellow
      Say '  켠 다음 이 파일을 다시 실행해 주세요.' Yellow
      Start-Process control.exe 'mmsys.cpl,,1'
    } else {
      Say 'VB-Cable(CABLE Output)도 스테레오 믹스도 찾지 못했어요.' Red
      Say '  송출기 사이트의 "처음 한 번만 준비하기"에서 둘 중 하나를 먼저 준비해 주세요.' Red
    }
    return
  }

  # 되돌릴 수 있게 지금 상태를 저장 (이미 저장돼 있으면 처음 상태를 유지)
  if (-not (Test-Path $SaveFile)) {
    New-Item -ItemType Directory -Force $StateDir | Out-Null
    $duck = (Get-ItemProperty $DuckKey -Name UserDuckingPreference -ErrorAction SilentlyContinue).UserDuckingPreference
    @{ comm = [MrAudio.Audio]::DefaultCapture(2); duck = $duck } | ConvertTo-Json | Set-Content $SaveFile -Encoding UTF8
  }

  [MrAudio.Audio]::SetDefault($target.Id, 2)
  if (-not (Test-Path $DuckKey)) { New-Item $DuckKey -Force | Out-Null }
  Set-ItemProperty $DuckKey -Name UserDuckingPreference -Value 3 -Type DWord   # 3 = 아무 작업도 안 함

  Say ''
  Say ('✅ 기본 통신 장치 → ' + $target.Name) Green
  Say '✅ [통신] 탭 → 아무 작업도 안 함' Green
  Say ''
  Say '이제 오버워치에서: 옵션 → 사운드 → 캡처 → 음성 대화 장치 → "대화 장치"' Cyan
  Say '노래가 끝나면 오버워치에서 "기본 장치"로 바꾸거나, 이 파일을 다시 실행해 2번(원래대로)을 고르세요.' Cyan
}

function Restore {
  if (Test-Path $SaveFile) {
    $s = Get-Content $SaveFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $comm = $s.comm
    if ($null -ne $s.duck) { Set-ItemProperty $DuckKey -Name UserDuckingPreference -Value ([int]$s.duck) -Type DWord }
    else { Remove-ItemProperty $DuckKey -Name UserDuckingPreference -ErrorAction SilentlyContinue }
  }
  # 저장된 게 없거나 그 장치가 사라졌으면, 평소 마이크(기본 장치)를 통신 장치로
  if (-not $comm -or -not (NameOf $comm)) { $comm = [MrAudio.Audio]::DefaultCapture(0) }
  if ($comm) { [MrAudio.Audio]::SetDefault($comm, 2) }
  Remove-Item $SaveFile -ErrorAction SilentlyContinue

  Say ''
  Say ('✅ 기본 통신 장치 → ' + (NameOf $comm)) Green
  Say '✅ [통신] 탭 설정도 원래대로' Green
  Say '오버워치 음성 대화 장치는 "기본 장치"로 두면 평소처럼 쓸 수 있어요.' Cyan
}

Say '=== MR 송출기 자동 설정 ===' Cyan
Say ('지금 기본 통신 장치: ' + (NameOf ([MrAudio.Audio]::DefaultCapture(2))))
Say ''
Say '  1) 노래 모드 켜기   (송출 장치를 통신 장치로)'
Say '  2) 원래대로'
$c = Read-Host '번호를 입력하고 Enter'
try {
  switch ($c.Trim()) {
    '1' { Sing }
    '2' { Restore }
    default { Say '1 또는 2를 입력해 주세요. 다시 실행해 주세요.' Yellow }
  }
} catch {
  Say ('설정 중 문제가 생겼어요: ' + $_.Exception.Message) Red
  Say '수동 방법: Win+R → mmsys.cpl → [녹음] 탭에서 직접 설정해 주세요.' Red
}
