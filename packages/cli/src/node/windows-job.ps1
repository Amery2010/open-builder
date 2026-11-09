# The only job handle stays in this helper. Killing the helper closes that
# handle and terminates the whole job, even after npm's original PID exits.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OpenBuilderJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfoEx {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    static IntPtr InheritedStream(int kind) {
        IntPtr copy;
        IntPtr self = GetCurrentProcess();
        Check(DuplicateHandle(self, GetStdHandle(kind), self, out copy, 0, true, 2));
        return copy;
    }
    static string Quote(string value) {
        // Windows C-runtime argv quoting; no command interpreter is involved.
        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"') {
                result.Append('\\', backslashes * 2 + 1).Append(ch);
            } else {
                result.Append('\\', backslashes).Append(ch);
            }
            backslashes = 0;
        }
        return result.Append('\\', backslashes * 2).Append('"').ToString();
    }

    public static int Run() {
        string manager = Environment.GetEnvironmentVariable("OPEN_BUILDER_VERIFY_MANAGER");
        string task = Environment.GetEnvironmentVariable("OPEN_BUILDER_VERIFY_TASK");
        if (manager != "npm" && manager != "pnpm") throw new ArgumentException("Unsupported package manager.");
        if (task != "build" && task != "typecheck" && task != "lint" && task != "test") throw new ArgumentException("Unsupported verification task.");
        string node = Environment.GetEnvironmentVariable("OPEN_BUILDER_VERIFY_NODE");
        uint parentId = UInt32.Parse(Environment.GetEnvironmentVariable("OPEN_BUILDER_VERIFY_PARENT"));
        IntPtr parent = OpenProcess(0x00100000, false, parentId); // SYNCHRONIZE
        if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr job = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        var process = new ProcessInfo();
        var startup = new StartupInfoEx();
        bool attributesInitialized = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            // JOB_LIST attaches ownership during process creation (Windows 10+).
            // There is no live or suspended child outside the job if this
            // supervisor is forcibly terminated during CreateProcessW.
            UIntPtr attributeBytes = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            startup.lpAttributeList = Marshal.AllocHGlobal(new IntPtr(checked((long)attributeBytes.ToUInt64())));
            Check(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref attributeBytes));
            attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                new UIntPtr(0x0002000D), // PROC_THREAD_ATTRIBUTE_JOB_LIST
                jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = InheritedStream(-10);
            startup.StartupInfo.hStdOutput = InheritedStream(-11);
            startup.StartupInfo.hStdError = InheritedStream(-12);
            if (WaitForSingleObject(parent, 0) != 0x00000102) return 130;

            // This fixed worker uses the installed dependency's Windows shim
            // handling. User paths and scripts never become PowerShell source.
            const string worker = "const spawn=require(process.env.OPEN_BUILDER_VERIFY_SPAWN);const manager=process.env.OPEN_BUILDER_VERIFY_MANAGER;const task=process.env.OPEN_BUILDER_VERIFY_TASK;for(const key of Object.keys(process.env)){if(key.startsWith('OPEN_BUILDER_VERIFY_'))delete process.env[key];}const child=spawn(manager,['run',task],{stdio:'inherit',windowsHide:true});child.once('error',()=>{console.error('The package manager could not start.');process.exitCode=126;});child.once('exit',(code)=>{process.exitCode=code===null?1:code;});";
            var command = new StringBuilder(Quote(node) + " -e " + Quote(worker));
            Check(CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00000004 | 0x08000000 | 0x00080000, // CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT
                IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process));
            if (WaitForSingleObject(parent, 0) != 0x00000102) return 130;
            if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());

            bool workerExited = false;
            uint code = 1;
            while (true) {
                if (WaitForSingleObject(parent, 0) != 0x00000102) {
                    Check(TerminateJobObject(job, 130));
                    return 130;
                }
                if (!workerExited && WaitForSingleObject(process.hProcess, 0) == 0) {
                    Check(GetExitCodeProcess(process.hProcess, out code));
                    workerExited = true;
                    // Verification ends with its root task. Background children
                    // belong to this run and must not retain its stdio or escape.
                    Check(TerminateJobObject(job, 0));
                }
                Accounting accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) break;
                Thread.Sleep(25);
            }
            if (!workerExited) Check(GetExitCodeProcess(process.hProcess, out code));
            return unchecked((int)code);
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (startup.StartupInfo.hStdInput != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdInput);
            if (startup.StartupInfo.hStdOutput != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdOutput);
            if (startup.StartupInfo.hStdError != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdError);
            if (attributesInitialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
            if (startup.lpAttributeList != IntPtr.Zero) Marshal.FreeHGlobal(startup.lpAttributeList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            CloseHandle(parent);
        }
    }
}
'@

try {
    exit [OpenBuilderJob]::Run()
} catch {
    [Console]::Error.WriteLine('Open Builder could not create or supervise the Windows verification job: ' + $_.Exception.Message)
    exit 126
}
