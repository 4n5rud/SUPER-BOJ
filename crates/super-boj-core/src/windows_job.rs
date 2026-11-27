use std::{
    io, mem,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        process::CommandExt,
    },
    process::Command,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
    },
};

/// Closing this non-inheritable handle terminates all remaining job members.
pub(crate) struct WindowsJob(OwnedHandle);

impl WindowsJob {
    pub(crate) fn prepare(command: &mut Command) -> io::Result<Self> {
        // Null attributes create a non-inheritable handle, even for the job's children.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        // The successful API call transfers ownership of one open handle.
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // The buffer matches the documented job information class and stays live for the call.
        let success = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                mem::size_of_val(&limits) as u32,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        command.creation_flags(CREATE_SUSPENDED);
        Ok(Self(job))
    }

    /// Keeps the primary thread suspended until job membership is established.
    pub(crate) fn attach_and_resume(&self, pid: u32, process: RawHandle) -> io::Result<()> {
        // The caller holds the process handle from spawn, with assignable access.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }

        // std::process retains the process handle but discards the primary thread handle.
        // Enumerate the suspended process's single initial thread with the documented API.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32::default();
        let entry_size = mem::size_of_val(&entry) as u32;
        entry.dwSize = entry_size;
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.dwSize >= entry_size && entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                return match unsafe { ResumeThread(thread.as_raw_handle()) } {
                    1 => Ok(()),
                    u32::MAX => Err(io::Error::last_os_error()),
                    _ => Err(io::Error::other("unexpected initial thread suspend count")),
                };
            }
            entry.dwSize = entry_size;
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "missing initial thread",
            ));
        }
        Err(error)
    }
}
