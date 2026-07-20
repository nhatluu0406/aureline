#![allow(non_snake_case)]

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use std::thread;

type Bool = i32;
type Dword = u32;
type Handle = *mut c_void;
const CREATE_SUSPENDED: Dword = 0x4;
const CREATE_UNICODE_ENVIRONMENT: Dword = 0x400;
const STARTF_USESTDHANDLES: Dword = 0x100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: i32 = 1;
const HANDLE_FLAG_INHERIT: Dword = 1;

#[repr(C)] struct SecurityAttributes { nLength: Dword, lpSecurityDescriptor: *mut c_void, bInheritHandle: Bool }
#[repr(C)] struct StartupInfoW {
    cb: Dword, lpReserved: *mut u16, lpDesktop: *mut u16, lpTitle: *mut u16,
    dwX: Dword, dwY: Dword, dwXSize: Dword, dwYSize: Dword, dwXCountChars: Dword,
    dwYCountChars: Dword, dwFillAttribute: Dword, dwFlags: Dword, wShowWindow: u16,
    cbReserved2: u16, lpReserved2: *mut u8, hStdInput: Handle, hStdOutput: Handle, hStdError: Handle,
}
#[repr(C)] struct ProcessInformation { hProcess: Handle, hThread: Handle, dwProcessId: Dword, dwThreadId: Dword }
#[repr(C)] #[derive(Default)] struct BasicLimit {
    PerProcessUserTimeLimit: i64, PerJobUserTimeLimit: i64, LimitFlags: Dword,
    MinimumWorkingSetSize: usize, MaximumWorkingSetSize: usize, ActiveProcessLimit: Dword,
    Affinity: usize, PriorityClass: Dword, SchedulingClass: Dword,
}
#[repr(C)] #[derive(Default)] struct IoCounters {
    ReadOperationCount: u64, WriteOperationCount: u64, OtherOperationCount: u64,
    ReadTransferCount: u64, WriteTransferCount: u64, OtherTransferCount: u64,
}
#[repr(C)] #[derive(Default)] struct ExtendedLimit {
    BasicLimitInformation: BasicLimit, IoInfo: IoCounters, ProcessMemoryLimit: usize,
    JobMemoryLimit: usize, PeakProcessMemoryUsed: usize, PeakJobMemoryUsed: usize,
}
#[repr(C)] #[derive(Default)] struct Accounting {
    TotalUserTime: i64, TotalKernelTime: i64, ThisPeriodTotalUserTime: i64,
    ThisPeriodTotalKernelTime: i64, TotalPageFaultCount: Dword, TotalProcesses: Dword,
    ActiveProcesses: Dword, TotalTerminatedProcesses: Dword,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut SecurityAttributes, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: Dword) -> Bool;
    fn QueryInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: Dword, returned: *mut Dword) -> Bool;
    fn CreateProcessW(app: *const u16, command: *mut u16, pa: *mut SecurityAttributes, ta: *mut SecurityAttributes,
        inherit: Bool, flags: Dword, environment: *const c_void, cwd: *const u16,
        startup: *mut StartupInfoW, process: *mut ProcessInformation) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn ResumeThread(thread: Handle) -> Dword;
    fn TerminateJobObject(job: Handle, exit_code: Dword) -> Bool;
    fn TerminateProcess(process: Handle, exit_code: Dword) -> Bool;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attributes: *mut SecurityAttributes, size: Dword) -> Bool;
    fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
    fn WriteFile(handle: Handle, buffer: *const c_void, bytes: Dword, written: *mut Dword, overlapped: *mut c_void) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> Dword;
}

struct Request { executable: String, cwd: String, args: Vec<String>, environment: Vec<(String, String)>, secret_frame: Vec<u8> }

fn read_u32(reader: &mut impl Read) -> io::Result<u32> { let mut b=[0;4]; reader.read_exact(&mut b)?; Ok(u32::from_le_bytes(b)) }
fn read_bytes(reader: &mut impl Read, max: usize) -> io::Result<Vec<u8>> {
    let length=read_u32(reader)? as usize; if length>max { return Err(io::Error::new(io::ErrorKind::InvalidData,"field too large")); }
    let mut b=vec![0;length]; reader.read_exact(&mut b)?; Ok(b)
}
fn read_string(reader: &mut impl Read, max: usize) -> io::Result<String> {
    String::from_utf8(read_bytes(reader,max)?).map_err(|_| io::Error::new(io::ErrorKind::InvalidData,"invalid UTF-8"))
}
fn read_request(reader: &mut impl Read) -> io::Result<Request> {
    let mut magic=[0;8]; reader.read_exact(&mut magic)?;
    if &magic!=b"AUR1JOB1" || read_u32(reader)?!=1 { return Err(io::Error::new(io::ErrorKind::InvalidData,"unsupported protocol")); }
    let executable=read_string(reader,32768)?; let cwd=read_string(reader,32768)?;
    let argc=read_u32(reader)?; if argc>256 { return Err(io::Error::new(io::ErrorKind::InvalidData,"too many arguments")); }
    let mut args=Vec::new(); for _ in 0..argc { args.push(read_string(reader,32768)?); }
    let envc=read_u32(reader)?; if envc>4096 { return Err(io::Error::new(io::ErrorKind::InvalidData,"too many environment entries")); }
    let mut environment=Vec::new(); for _ in 0..envc { environment.push((read_string(reader,32768)?,read_string(reader,1_048_576)?)); }
    let secret_frame=read_bytes(reader,16*1024)?;
    if secret_frame.is_empty() || !secret_frame.ends_with(b"\n") { return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid secret frame")); }
    Ok(Request{executable,cwd,args,environment,secret_frame})
}
fn wide(value:&str)->Vec<u16>{OsStr::new(value).encode_wide().chain(Some(0)).collect()}
fn quote(value:&str)->String{
    if !value.is_empty()&&!value.chars().any(|c|c==' '||c=='\t'||c=='"'){return value.to_owned();}
    let mut out=String::from("\"");let mut slashes=0;
    for c in value.chars(){if c=='\\'{slashes+=1}else if c=='"'{out.push_str(&"\\".repeat(slashes*2+1));out.push('"');slashes=0}else{out.push_str(&"\\".repeat(slashes));slashes=0;out.push(c)}}
    out.push_str(&"\\".repeat(slashes*2));out.push('"');out
}
fn command_line(exe:&str,args:&[String])->Vec<u16>{let mut p=vec![quote(exe)];p.extend(args.iter().map(|v|quote(v)));wide(&p.join(" "))}
fn environment_block(entries:&[(String,String)])->Vec<u16>{
    let mut sorted=entries.to_vec();sorted.sort_by_key(|v|v.0.to_ascii_lowercase());let mut out=Vec::new();
    for (k,v) in sorted{out.extend(OsStr::new(&format!("{k}={v}")).encode_wide());out.push(0)}out.push(0);out
}
fn escape(value:&str)->String{value.chars().flat_map(|c|match c{'"'=>"\\\"".chars().collect::<Vec<_>>(),'\\'=>"\\\\".chars().collect(), '\n'=>"\\n".chars().collect(), '\r'=>Vec::new(), _=>vec![c]}).collect()}
fn emit(value:&str){let mut out=io::stdout().lock();let _=writeln!(out,"{value}");let _=out.flush();}
fn error(stage:&str,code:u32,message:&str){emit(&format!("{{\"event\":\"error\",\"stage\":\"{stage}\",\"win32Error\":{code},\"message\":\"{}\"}}",escape(message)));}
unsafe fn close(handle:Handle){if !handle.is_null(){CloseHandle(handle);}}
unsafe fn pipe(attributes:&mut SecurityAttributes, child_reads: bool)->Result<(Handle,Handle),u32>{
    let(mut read,mut write)=(null_mut(),null_mut());if CreatePipe(&mut read,&mut write,attributes,0)==0{return Err(GetLastError())}
    let parent_handle=if child_reads{write}else{read};
    if SetHandleInformation(parent_handle,HANDLE_FLAG_INHERIT,0)==0{let e=GetLastError();close(read);close(write);return Err(e)}Ok((read,write))
}
unsafe fn active(job:Handle)->Result<(u32,u32),u32>{
    let mut info:Accounting=zeroed();if QueryInformationJobObject(job,JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,&mut info as *mut _ as *mut c_void,size_of::<Accounting>() as u32,null_mut())==0{return Err(GetLastError())}
    Ok((info.ActiveProcesses,info.TotalProcesses))
}

unsafe fn run(mut reader:BufReader<io::StdinLock<'_>>)->i32{
    let request=match read_request(&mut reader){Ok(v)=>v,Err(e)=>{error("protocol",0,&e.to_string());return 2}};
    let job=CreateJobObjectW(null_mut(),null());if job.is_null(){error("create_job",GetLastError(),"CreateJobObjectW failed");return 3}
    let mut limits:ExtendedLimit=zeroed();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(job,JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,&limits as *const _ as *const c_void,size_of::<ExtendedLimit>() as u32)==0{error("configure_job",GetLastError(),"SetInformationJobObject failed");close(job);return 4}
    let mut sa=SecurityAttributes{nLength:size_of::<SecurityAttributes>() as u32,lpSecurityDescriptor:null_mut(),bInheritHandle:1};
    let(stdin_read,stdin_write)=match pipe(&mut sa,true){Ok(v)=>v,Err(e)=>{error("stdin_pipe",e,"CreatePipe failed");close(job);return 5}};
    // The parent must retain the output read handle, while the child inherits only the write handle.
    let(mut output_read,mut output_write)=(null_mut(),null_mut());
    if CreatePipe(&mut output_read,&mut output_write,&mut sa,0)==0||SetHandleInformation(output_read,HANDLE_FLAG_INHERIT,0)==0{
        error("output_pipe",GetLastError(),"CreatePipe failed");close(stdin_read);close(stdin_write);close(job);return 6
    }
    let exe=wide(&request.executable);let cwd=wide(&request.cwd);let mut cmd=command_line(&request.executable,&request.args);let env=environment_block(&request.environment);
    let mut startup:StartupInfoW=zeroed();startup.cb=size_of::<StartupInfoW>() as u32;startup.dwFlags=STARTF_USESTDHANDLES;startup.hStdInput=stdin_read;startup.hStdOutput=output_write;startup.hStdError=output_write;
    let mut process:ProcessInformation=zeroed();
    if CreateProcessW(exe.as_ptr(),cmd.as_mut_ptr(),null_mut(),null_mut(),1,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,env.as_ptr() as *const c_void,cwd.as_ptr(),&mut startup,&mut process)==0{
        error("create_process",GetLastError(),"CreateProcessW(CREATE_SUSPENDED) failed");close(stdin_read);close(stdin_write);close(output_read);close(output_write);close(job);return 7
    }
    close(stdin_read);close(output_write);
    if AssignProcessToJobObject(job,process.hProcess)==0{let e=GetLastError();error("assign",e,"AssignProcessToJobObject failed before resume");TerminateProcess(process.hProcess,210);close(stdin_write);close(output_read);close(process.hThread);close(process.hProcess);close(job);return 8}
    let mut written=0;if WriteFile(stdin_write,request.secret_frame.as_ptr() as *const c_void,request.secret_frame.len() as u32,&mut written,null_mut())==0||written as usize!=request.secret_frame.len(){
        error("secret_pipe",GetLastError(),"secret frame write failed");TerminateProcess(process.hProcess,211);close(stdin_write);close(output_read);close(process.hThread);close(process.hProcess);close(job);return 9
    }close(stdin_write);
    if ResumeThread(process.hThread)==u32::MAX{error("resume",GetLastError(),"ResumeThread failed");TerminateProcess(process.hProcess,212);close(output_read);close(process.hThread);close(process.hProcess);close(job);return 10}
    let pid=process.dwProcessId;close(process.hThread);close(process.hProcess);
    let read_handle=output_read as usize;
    thread::spawn(move||{let file=File::from_raw_handle(read_handle as *mut c_void);for line in BufReader::new(file).lines(){match line{Ok(v)=>emit(&format!("{{\"event\":\"log\",\"stream\":\"forge\",\"message\":\"{}\"}}",escape(&v))),Err(_)=>break}}});
    emit(&format!("{{\"event\":\"ready\",\"pid\":{pid},\"createdSuspended\":true,\"assignedBeforeResume\":true,\"resumed\":true,\"killOnClose\":true}}"));
    let mut line=String::new();loop{line.clear();match reader.read_line(&mut line){Ok(0)=>break,Err(_)=>break,Ok(_)=>{}}
        let cmd=line.trim();if cmd=="QUERY"{match active(job){Ok((a,t))=>emit(&format!("{{\"event\":\"query\",\"activeProcesses\":{a},\"totalProcesses\":{t}}}")),Err(e)=>error("query",e,"QueryInformationJobObject failed")}}
        else if cmd=="CLOSE"{close(job);emit("{\"event\":\"closed\"}");return 0}
        else if cmd.starts_with("TERMINATE"){if TerminateJobObject(job,220)==0{error("terminate",GetLastError(),"TerminateJobObject failed")}else{emit("{\"event\":\"terminated\"}")}}
        else if cmd=="EXIT"{break}else{error("protocol",0,"unknown command")}
    }close(job);0
}
fn main(){let code=unsafe{run(BufReader::new(io::stdin().lock()))};std::process::exit(code)}
