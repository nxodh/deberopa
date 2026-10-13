"""
Drive the terminal UI in a pseudo-terminal against the mock LLM and print what it drew.
  python3 script/tui-pty.py [command...]      default command: the local bun running src/index.ts
Dev/CI helper only (POSIX). Exits non-zero when an expected string never appears.
"""
import os, pty, re, select, subprocess, sys, tempfile, time, json, fcntl, struct, termios, shutil, signal

def _timeout(*_):
    sys.stderr.write("harness timed out\n")
    try:
        mock.kill()
        os.kill(pid, 9)
    except Exception:
        pass
    os._exit(3)
signal.signal(signal.SIGALRM, _timeout)
signal.alarm(int(os.environ.get("HARNESS_TIMEOUT", "90")))

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bun = [os.path.join(root, "node_modules", ".bin", "bun")]
cmd = sys.argv[1:] or bun + ["run", os.path.join(root, "src", "index.ts")]

mock = subprocess.Popen(bun + ["run", os.path.join(root, "script", "mock-llm.ts")], stdout=subprocess.PIPE, text=True)
port = int(mock.stdout.readline().strip())
sys.stderr.write(f"mock on {port}\n")
home = tempfile.mkdtemp(prefix="vdc-tui-home-")
work = os.path.realpath(tempfile.mkdtemp(prefix="vdc-tui-work-"))
open(os.path.join(work, "hello.txt"), "w").write("greetings\n")
if os.environ.get("GIT_REPO"):
    for cmd_ in (["git", "init", "-q", "-b", "trunk"], ["git", "config", "user.email", "t@example.com"], ["git", "config", "user.name", "t"],
                 ["git", "add", "-A"], ["git", "commit", "-qm", "init"]):
        subprocess.run(cmd_, cwd=work, check=True)
config = {"model": "mock/m", "snapshot": False,
          "provider": {"mock": {"name": "Mock", "api": f"http://127.0.0.1:{port}/v1",
                                "models": {"m": {"name": "Mock Model", "tool_call": True, "limit": {"context": 100000, "output": 4000}}}}}}
if os.environ.get("ASK_EDIT"):
    config["permission"] = {"edit": "ask"}
env = dict(os.environ, VEDECAPS_HOME=home, VEDECAPS_DISABLE_MODELS_FETCH="1", VEDECAPS_CONFIG_CONTENT=json.dumps(config), TERM="xterm-256color")
env.pop("CI", None)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execvpe(cmd[0], cmd, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))

buf = b""
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
    return True

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]|\r")
def text():
    return ANSI.sub(b"", buf).decode("utf-8", "replace")

failures = []
def expect(needle, seconds=8.0):
    sys.stderr.write(f"expect {needle!r}\n")
    end = time.time() + seconds
    while time.time() < end:
        if needle in text():
            return True
        if not pump(0.2):
            break
    failures.append(needle)
    return False

def send(s, wait=0.4):
    os.write(fd, s.encode())
    pump(wait)

try:
    expect("V E D E C A P S", 20)
    if os.environ.get("GIT_REPO"):
        expect("⎇ trunk", 10)
    expect("Ask anything")
    send("안녕 read the file")
    send("\r", 0.2)
    expect("Read")
    expect("완료", 10)
    expect("second item")
    send("/")
    expect("/sessions")
    send("\x1b", 0.3)
    send("\x7f", 0.2)
    send("/help\r", 0.6)
    expect("Keys")
    send("\x1b", 0.4)
    send("edit the notes\r", 0.5)
    expect("Permission required", 10) if os.environ.get("ASK_EDIT") else expect("Write", 10)
    send("y", 0.5)
    if os.environ.get("GIT_REPO"):
        expect("1 changed", 10)  # the file the agent wrote shows up in the status bar
    if os.environ.get("ASK_EDIT"):
        expect("Write", 10)
    pump(1.5)
    send("\x04", 0.5)
    pump(1.5)

except OSError as e:
    failures.append(f'terminal closed early: {e}')

out = text()
print(out[-int(os.environ.get("TAIL", "6000")):])
try:
    os.kill(pid, 9)
except OSError:
    pass
mock.kill()
shutil.rmtree(home, ignore_errors=True)
shutil.rmtree(work, ignore_errors=True)
if failures:
    print("\nMISSING:", failures)
    sys.exit(1)
print("\nTUI OK")
