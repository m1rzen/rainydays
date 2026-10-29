/**
 * Developer-mode raw-pipe host. Join a kill-on-close Job BEFORE creating the
 * payload, so even a crashing MCP parent cannot strand its normal descendants.
 * No SEC-03 code or AppContainer profile is changed. The script is constant;
 * launch data travels through a private environment value, never shell source.
 * https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 */
export const WINDOWS_JOB_HOST = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
public static class RainyDaysMcpHost {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string arg) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in arg) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static Task Pump(Stream input, Stream output) {
    return Task.Run(async () => {
      var buffer = new byte[16384]; int count;
      while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) > 0) {
        await output.WriteAsync(buffer, 0, count); await output.FlushAsync();
      }
    });
  }
  public static void Run(string command, string[] args, string cwd, string[] keys, string[] values) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException("MCP Job creation failed");
    var limits = new Limits(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
      CloseHandle(job); throw new InvalidOperationException("MCP Job assignment failed");
    }
    try {
      var quoted = new string[args.Length]; for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
      var info = new ProcessStartInfo(command, String.Join(" ", quoted));
      info.WorkingDirectory = cwd; info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      info.EnvironmentVariables.Clear(); for (int i = 0; i < keys.Length; i++) info.EnvironmentVariables[keys[i]] = values[i];
      using (var child = Process.Start(info)) {
        var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
        var errors = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
        var input = Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream);
        var exit = Task.Run(() => child.WaitForExit());
        Task.WaitAny(input, exit);
        if (child.HasExited) Task.WaitAll(new Task[] {output, errors}, 500);
      }
    } finally { TerminateJobObject(job, 0); CloseHandle(job); }
  }
}
'@
try {
  $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RAINYDAYS_MCP_LAUNCH)) | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('RAINYDAYS_MCP_LAUNCH', $null)
  $keys = @(); $values = @()
  foreach ($property in $launch.env.PSObject.Properties) { $keys += $property.Name; $values += [string]$property.Value }
  [RainyDaysMcpHost]::Run([string]$launch.command, [string[]]$launch.args, [string]$launch.cwd, [string[]]$keys, [string[]]$values)
} catch { [Console]::Error.WriteLine('MCP controlled process host failed'); exit 1 }
`;
