#![allow(non_snake_case)]

use std::ffi::{c_void, OsStr};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;

const CREATE_SUSPENDED: Dword = 0x0000_0004;
const CREATE_BREAKAWAY_FROM_JOB: Dword = 0x0100_0000;
const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
const STARTF_USESTDHANDLES: Dword = 0x0000_0100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: i32 = 1;
const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x0000_1000;
const GENERIC_READ: Dword = 0x8000_0000;
const GENERIC_WRITE: Dword = 0x4000_0000;
const FILE_SHARE_READ: Dword = 0x0000_0001;
const FILE_SHARE_WRITE: Dword = 0x0000_0002;
const OPEN_EXISTING: Dword = 3;
const FILE_ATTRIBUTE_NORMAL: Dword = 0x0000_0080;
const STILL_ACTIVE: Dword = 259;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

#[repr(C)]
struct SecurityAttributes {
    nLength: Dword,
    lpSecurityDescriptor: *mut c_void,
    bInheritHandle: Bool,
}

#[repr(C)]
struct StartupInfoW {
    cb: Dword,
    lpReserved: *mut u16,
    lpDesktop: *mut u16,
    lpTitle: *mut u16,
    dwX: Dword,
    dwY: Dword,
    dwXSize: Dword,
    dwYSize: Dword,
    dwXCountChars: Dword,
    dwYCountChars: Dword,
    dwFillAttribute: Dword,
    dwFlags: Dword,
    wShowWindow: u16,
    cbReserved2: u16,
    lpReserved2: *mut u8,
    hStdInput: Handle,
    hStdOutput: Handle,
    hStdError: Handle,
}

#[repr(C)]
struct ProcessInformation {
    hProcess: Handle,
    hThread: Handle,
    dwProcessId: Dword,
    dwThreadId: Dword,
}

#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    PerProcessUserTimeLimit: i64,
    PerJobUserTimeLimit: i64,
    LimitFlags: Dword,
    MinimumWorkingSetSize: usize,
    MaximumWorkingSetSize: usize,
    ActiveProcessLimit: Dword,
    Affinity: usize,
    PriorityClass: Dword,
    SchedulingClass: Dword,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    ReadOperationCount: u64,
    WriteOperationCount: u64,
    OtherOperationCount: u64,
    ReadTransferCount: u64,
    WriteTransferCount: u64,
    OtherTransferCount: u64,
}

#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    BasicLimitInformation: JobObjectBasicLimitInformation,
    IoInfo: IoCounters,
    ProcessMemoryLimit: usize,
    JobMemoryLimit: usize,
    PeakProcessMemoryUsed: usize,
    PeakJobMemoryUsed: usize,
}

#[repr(C)]
#[derive(Default)]
struct JobObjectBasicAccountingInformation {
    TotalUserTime: i64,
    TotalKernelTime: i64,
    ThisPeriodTotalUserTime: i64,
    ThisPeriodTotalKernelTime: i64,
    TotalPageFaultCount: Dword,
    TotalProcesses: Dword,
    ActiveProcesses: Dword,
    TotalTerminatedProcesses: Dword,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut SecurityAttributes, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: Dword) -> Bool;
    fn QueryInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: Dword, returned: *mut Dword) -> Bool;
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut SecurityAttributes,
        thread_attributes: *mut SecurityAttributes,
        inherit_handles: Bool,
        creation_flags: Dword,
        environment: *const c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn ResumeThread(thread: Handle) -> Dword;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> Bool;
    fn TerminateProcess(process: Handle, exit_code: u32) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn IsProcessInJob(process: Handle, job: Handle, result: *mut Bool) -> Bool;
    fn OpenProcess(access: Dword, inherit: Bool, process_id: Dword) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn GetLastError() -> Dword;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut Dword) -> Bool;
    fn CreateFileW(
        file_name: *const u16,
        desired_access: Dword,
        share_mode: Dword,
        security: *mut SecurityAttributes,
        creation_disposition: Dword,
        flags: Dword,
        template: Handle,
    ) -> Handle;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FailureStage {
    None,
    Assign,
    Resume,
}

struct LaunchRequest {
    executable: String,
    cwd: String,
    args: Vec<String>,
    environment: Vec<(String, String)>,
    failure_stage: FailureStage,
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn quote_argument(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return value.to_owned();
    }
    let mut output = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
        } else if character == '"' {
            output.push_str(&"\\".repeat(slashes * 2 + 1));
            output.push('"');
            slashes = 0;
        } else {
            output.push_str(&"\\".repeat(slashes));
            slashes = 0;
            output.push(character);
        }
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}

fn command_line(executable: &str, args: &[String]) -> Vec<u16> {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_argument(executable));
    parts.extend(args.iter().map(|arg| quote_argument(arg)));
    wide_null(&parts.join(" "))
}

fn environment_block(entries: &[(String, String)]) -> Option<Vec<u16>> {
    if entries.is_empty() {
        return None;
    }
    let mut sorted = entries.to_vec();
    sorted.sort_by(|left, right| left.0.to_ascii_lowercase().cmp(&right.0.to_ascii_lowercase()));
    let mut block = Vec::new();
    for (key, value) in sorted {
        block.extend(OsStr::new(&format!("{key}={value}")).encode_wide());
        block.push(0);
    }
    block.push(0);
    Some(block)
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_string(reader: &mut impl Read) -> io::Result<String> {
    let length = read_u32(reader)? as usize;
    if length > 1_048_576 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "string too large"));
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8"))
}

fn read_request(reader: &mut impl Read) -> io::Result<LaunchRequest> {
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != b"FJOBSPK1" || read_u32(reader)? != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unsupported protocol"));
    }
    let failure_stage = match read_u32(reader)? {
        0 => FailureStage::None,
        1 => FailureStage::Assign,
        2 => FailureStage::Resume,
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unknown failure stage")),
    };
    let executable = read_string(reader)?;
    let cwd = read_string(reader)?;
    let argument_count = read_u32(reader)?;
    if argument_count > 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too many arguments"));
    }
    let mut args = Vec::with_capacity(argument_count as usize);
    for _ in 0..argument_count {
        args.push(read_string(reader)?);
    }
    let environment_count = read_u32(reader)?;
    if environment_count > 4096 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too many environment entries"));
    }
    let mut environment = Vec::with_capacity(environment_count as usize);
    for _ in 0..environment_count {
        environment.push((read_string(reader)?, read_string(reader)?));
    }
    Ok(LaunchRequest { executable, cwd, args, environment, failure_stage })
}

fn emit(value: &str) {
    let mut output = io::stdout().lock();
    let _ = writeln!(output, "{value}");
    let _ = output.flush();
}

fn emit_error(stage: &str, code: u32, message: &str) {
    emit(&format!(
        "{{\"event\":\"error\",\"stage\":\"{stage}\",\"win32Error\":{code},\"message\":\"{message}\"}}"
    ));
}

unsafe fn close_if_valid(handle: Handle) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        CloseHandle(handle);
    }
}

unsafe fn open_null_handles() -> Result<(Handle, Handle), u32> {
    let mut security = SecurityAttributes {
        nLength: size_of::<SecurityAttributes>() as Dword,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let name = wide_null("NUL");
    let input = CreateFileW(
        name.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &mut security,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut(),
    );
    if input == INVALID_HANDLE_VALUE {
        return Err(GetLastError());
    }
    let output = CreateFileW(
        name.as_ptr(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &mut security,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut(),
    );
    if output == INVALID_HANDLE_VALUE {
        close_if_valid(input);
        return Err(GetLastError());
    }
    Ok((input, output))
}

unsafe fn query_in_job(process: Handle, job: Handle) -> Result<bool, u32> {
    let mut result: Bool = 0;
    if IsProcessInJob(process, job, &mut result) == 0 {
        return Err(GetLastError());
    }
    Ok(result != 0)
}

unsafe fn query_job(job: Handle) -> Result<(u32, u32, u32), u32> {
    let mut limits: JobObjectExtendedLimitInformation = zeroed();
    if QueryInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        &mut limits as *mut _ as *mut c_void,
        size_of::<JobObjectExtendedLimitInformation>() as Dword,
        null_mut(),
    ) == 0 {
        return Err(GetLastError());
    }
    let mut accounting: JobObjectBasicAccountingInformation = zeroed();
    if QueryInformationJobObject(
        job,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        &mut accounting as *mut _ as *mut c_void,
        size_of::<JobObjectBasicAccountingInformation>() as Dword,
        null_mut(),
    ) == 0 {
        return Err(GetLastError());
    }
    Ok((limits.BasicLimitInformation.LimitFlags, accounting.ActiveProcesses, accounting.TotalProcesses))
}

unsafe fn run_owner(mut reader: BufReader<io::StdinLock<'_>>) -> i32 {
    let request = match read_request(&mut reader) {
        Ok(request) => request,
        Err(error) => {
            emit_error("protocol", 0, &error.to_string().replace('"', "'"));
            return 2;
        }
    };

    let mut job = CreateJobObjectW(null_mut(), null());
    if job.is_null() {
        emit_error("create_job", GetLastError(), "CreateJobObjectW failed");
        return 3;
    }
    let mut limits: JobObjectExtendedLimitInformation = zeroed();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        &limits as *const _ as *const c_void,
        size_of::<JobObjectExtendedLimitInformation>() as Dword,
    ) == 0 {
        let code = GetLastError();
        emit_error("configure_job", code, "SetInformationJobObject failed");
        close_if_valid(job);
        return 4;
    }

    let (null_input, null_output) = match open_null_handles() {
        Ok(handles) => handles,
        Err(code) => {
            emit_error("stdio", code, "Could not open NUL handles");
            close_if_valid(job);
            return 5;
        }
    };
    let executable = wide_null(&request.executable);
    let cwd = wide_null(&request.cwd);
    let mut command = command_line(&request.executable, &request.args);
    let environment = environment_block(&request.environment);
    let environment_pointer = environment.as_ref().map_or(null(), |block| block.as_ptr()) as *const c_void;
    let mut startup: StartupInfoW = zeroed();
    startup.cb = size_of::<StartupInfoW>() as Dword;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = null_input;
    startup.hStdOutput = null_output;
    startup.hStdError = null_output;
    let mut process: ProcessInformation = zeroed();
    let created = CreateProcessW(
        executable.as_ptr(), command.as_mut_ptr(), null_mut(), null_mut(), 1,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        environment_pointer, cwd.as_ptr(), &mut startup, &mut process,
    );
    close_if_valid(null_input);
    close_if_valid(null_output);
    if created == 0 {
        let code = GetLastError();
        emit_error("create_process", code, "CreateProcessW(CREATE_SUSPENDED) failed");
        close_if_valid(job);
        return 6;
    }

    let assigned = if request.failure_stage == FailureStage::Assign {
        AssignProcessToJobObject(null_mut(), process.hProcess)
    } else {
        AssignProcessToJobObject(job, process.hProcess)
    };
    if assigned == 0 {
        let code = GetLastError();
        emit_error("assign", code, "AssignProcessToJobObject failed before resume");
        TerminateProcess(process.hProcess, 210);
        close_if_valid(process.hThread);
        close_if_valid(process.hProcess);
        close_if_valid(job);
        return 7;
    }

    let resume_handle = if request.failure_stage == FailureStage::Resume {
        close_if_valid(process.hThread);
        null_mut()
    } else {
        process.hThread
    };
    let resume_result = ResumeThread(resume_handle);
    if resume_result == u32::MAX {
        let code = GetLastError();
        emit_error("resume", code, "ResumeThread failed after assignment");
        TerminateProcess(process.hProcess, 211);
        if request.failure_stage != FailureStage::Resume {
            close_if_valid(process.hThread);
        }
        close_if_valid(process.hProcess);
        close_if_valid(job);
        return 8;
    }
    close_if_valid(process.hThread);
    close_if_valid(process.hProcess);

    let current_in_job = query_in_job(GetCurrentProcess(), null_mut()).unwrap_or(false);
    let root_in_job = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.dwProcessId);
    let assigned_to_job = if root_in_job.is_null() {
        false
    } else {
        let result = query_in_job(root_in_job, job).unwrap_or(false);
        close_if_valid(root_in_job);
        result
    };
    let (flags, active, total) = query_job(job).unwrap_or((0, 0, 0));
    emit(&format!(
        "{{\"event\":\"ready\",\"ownerPid\":{},\"pid\":{},\"createdSuspended\":true,\"assignedBeforeResume\":true,\"resumed\":true,\"rootInJob\":{},\"ownerInOuterJob\":{},\"limitFlags\":{},\"activeProcesses\":{},\"totalProcesses\":{}}}",
        std::process::id(), process.dwProcessId, assigned_to_job, current_in_job, flags, active, total
    ));

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let command = line.trim();
        if command == "QUERY" {
            if job.is_null() {
                emit("{\"event\":\"query\",\"status\":\"closed\"}");
            } else {
                match query_job(job) {
                    Ok((query_flags, query_active, query_total)) => emit(&format!(
                        "{{\"event\":\"query\",\"status\":\"open\",\"limitFlags\":{query_flags},\"activeProcesses\":{query_active},\"totalProcesses\":{query_total}}}"
                    )),
                    Err(code) => emit_error("query", code, "QueryInformationJobObject failed"),
                }
            }
        } else if let Some(pid_text) = command.strip_prefix("CHECK ") {
            let pid = pid_text.parse::<u32>().unwrap_or(0);
            let target = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if target.is_null() {
                emit_error("open_process", GetLastError(), "OpenProcess failed");
            } else {
                let result = if job.is_null() { Ok(false) } else { query_in_job(target, job) };
                close_if_valid(target);
                match result {
                    Ok(in_job) => emit(&format!("{{\"event\":\"checked\",\"pid\":{pid},\"inJob\":{in_job}}}")),
                    Err(code) => emit_error("check", code, "IsProcessInJob failed"),
                }
            }
        } else if let Some(exit_text) = command.strip_prefix("TERMINATE") {
            let exit_code = exit_text.trim().parse::<u32>().unwrap_or(220);
            if job.is_null() {
                emit("{\"event\":\"terminated\",\"status\":\"already_closed\"}");
            } else if TerminateJobObject(job, exit_code) == 0 {
                emit_error("terminate", GetLastError(), "TerminateJobObject failed");
            } else {
                emit("{\"event\":\"terminated\",\"status\":\"terminated\"}");
            }
        } else if command == "CLOSE" {
            if job.is_null() {
                emit("{\"event\":\"closed\",\"status\":\"already_closed\"}");
            } else {
                CloseHandle(job);
                job = null_mut();
                emit("{\"event\":\"closed\",\"status\":\"closed\"}");
            }
        } else if command == "EXIT" {
            break;
        } else {
            emit_error("protocol", 0, "unknown command");
        }
    }
    close_if_valid(job);
    0
}

unsafe fn run_breakaway_probe(args: &[String]) -> i32 {
    if args.is_empty() {
        emit_error("breakaway", 0, "missing executable");
        return 20;
    }
    let executable = wide_null(&args[0]);
    let mut command = command_line(&args[0], &args[1..]);
    let mut startup: StartupInfoW = zeroed();
    startup.cb = size_of::<StartupInfoW>() as Dword;
    let mut process: ProcessInformation = zeroed();
    if CreateProcessW(
        executable.as_ptr(), command.as_mut_ptr(), null_mut(), null_mut(), 0,
        CREATE_BREAKAWAY_FROM_JOB, null(), null(), &mut startup, &mut process,
    ) == 0 {
        emit(&format!("{{\"event\":\"breakaway\",\"succeeded\":false,\"win32Error\":{}}}", GetLastError()));
        return 0;
    }
    let mut exit_code = STILL_ACTIVE;
    GetExitCodeProcess(process.hProcess, &mut exit_code);
    emit(&format!("{{\"event\":\"breakaway\",\"succeeded\":true,\"pid\":{},\"exitCode\":{exit_code}}}", process.dwProcessId));
    close_if_valid(process.hThread);
    close_if_valid(process.hProcess);
    0
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let exit_code = unsafe {
        if arguments.get(1).map(String::as_str) == Some("--self-job-state") {
            let state = query_in_job(GetCurrentProcess(), null_mut()).unwrap_or(false);
            emit(&format!("{{\"event\":\"self_job_state\",\"inJob\":{state},\"pid\":{}}}", std::process::id()));
            0
        } else if arguments.get(1).map(String::as_str) == Some("--breakaway-probe") {
            run_breakaway_probe(&arguments[2..])
        } else {
            run_owner(BufReader::new(io::stdin().lock()))
        }
    };
    std::process::exit(exit_code);
}
