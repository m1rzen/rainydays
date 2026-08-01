export const windowsFileHandleObserverScript = String.raw`
$ProgressPreference = "SilentlyContinue"
$Path = [string]$env:RAINYDAYS_HANDLE_OBSERVER_PATH
[uint32]$RootProcessId = [uint32]::Parse($env:RAINYDAYS_HANDLE_OBSERVER_ROOT_PID)
if ([string]::IsNullOrWhiteSpace($Path) -or $RootProcessId -eq 0) { throw "invalid observer input" }

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RainyDaysFileHandleObserver
{
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const int FileProcessIdsUsingFileInformation = 47;
    private const uint TH32CS_SNAPPROCESS = 0x2;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_STATUS_BLOCK
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationFile(SafeFileHandle fileHandle, out IO_STATUS_BLOCK ioStatusBlock,
        IntPtr fileInformation, uint length, int fileInformationClass);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static ulong[] Query(string path)
    {
        IntPtr raw = CreateFileW(path, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (raw == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (var handle = new SafeFileHandle(raw, true))
        {
            const int bufferSize = 65536;
            IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
            try
            {
                IO_STATUS_BLOCK ioStatusBlock;
                int status = NtQueryInformationFile(handle, out ioStatusBlock, buffer, bufferSize,
                    FileProcessIdsUsingFileInformation);
                if (status != 0)
                    throw new InvalidOperationException("NtQueryInformationFile status 0x" + status.ToString("X8"));
                uint count = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                if (count > 4096)
                    throw new InvalidOperationException("PID count exceeds bounded observer capacity");
                int firstPidOffset = IntPtr.Size;
                var result = new List<ulong>((int)count);
                for (uint index = 0; index < count; index++)
                {
                    int offset = checked(firstPidOffset + (int)index * IntPtr.Size);
                    ulong pid = IntPtr.Size == 8
                        ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                        : unchecked((uint)Marshal.ReadInt32(buffer, offset));
                    result.Add(pid);
                }
                return result.ToArray();
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    public static ulong[] MatchingProcessTreePids(string path, uint rootPid)
    {
        if (rootPid == 0) throw new ArgumentOutOfRangeException("rootPid");
        var before = new HashSet<ulong>(Query(path));
        var parents = SnapshotParents();
        var matches = new List<ulong>();
        foreach (ulong holder in Query(path))
        {
            if (before.Contains(holder) && holder <= UInt32.MaxValue && IsInTree((uint)holder, rootPid, parents))
                matches.Add(holder);
        }
        return matches.ToArray();
    }

    private static Dictionary<uint, uint> SnapshotParents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var result = new Dictionary<uint, uint>();
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do
            {
                result[entry.th32ProcessID] = entry.th32ParentProcessID;
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            } while (Process32NextW(snapshot, ref entry));
            return result;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static bool IsInTree(uint pid, uint rootPid, Dictionary<uint, uint> parents)
    {
        var seen = new HashSet<uint>();
        uint current = pid;
        for (int depth = 0; depth < 4096 && current != 0 && seen.Add(current); depth++)
        {
            if (current == rootPid) return true;
            uint parent;
            if (!parents.TryGetValue(current, out parent)) return false;
            current = parent;
        }
        return false;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
$holders = @([RainyDaysFileHandleObserver]::Query($Path) | Sort-Object -Unique)
$matching = @([RainyDaysFileHandleObserver]::MatchingProcessTreePids($Path, $RootProcessId) | Sort-Object -Unique)
[ordered]@{
  holderCount = $holders.Count
  matchingCount = $matching.Count
  matched = $matching.Count -gt 0
} | ConvertTo-Json -Compress
`;
