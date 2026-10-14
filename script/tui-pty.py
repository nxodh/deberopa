"""
Drive the terminal UI in a pseudo-terminal against the mock LLM and print what it drew.
  python3 script/tui-pty.py [command...]      default command: the local bun running src/index.ts
Dev/CI helper only (POSIX). Exits non-zero when an expected string never appears.
"""
import os, pty, re, select, subprocess, sys, tempfile, time, json, fcntl, struct, termios, shutil, signal, codecs
import pyte

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
editor = os.path.join(home, "editor.py")
with open(editor, "w") as file:
    file.write('#!/usr/bin/env python3\nimport sys\nwith open(sys.argv[1], "w") as f: f.write("editor fixture\\nsecond line")\n')
os.chmod(editor, 0o755)
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
submit_key = "\x07" if os.environ.get("CUSTOM_KEYS") else "\r"
if os.environ.get("CUSTOM_KEYS"):
    config["keybinds"] = {"submit": "ctrl+g"}
env = dict(os.environ, DEBEROPA_HOME=home, DEBEROPA_DISABLE_MODELS_FETCH="1", DEBEROPA_DISABLE_LOCAL_DETECT="1", DEBEROPA_CONFIG_CONTENT=json.dumps(config), TERM="xterm-256color", EDITOR=editor)
env.pop("CI", None)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execvpe(cmd[0], cmd, env)
terminal_rows, terminal_columns = 32, 100
screen = pyte.Screen(terminal_columns, terminal_rows)
screen_stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder("utf-8")("replace")
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", terminal_rows, terminal_columns, 0, 0))

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
            screen_stream.feed(decoder.decode(data))
    return True

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]|\r")
def text():
    return "\n".join(screen.display)

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

def resize(rows, columns):
    global terminal_rows, terminal_columns
    terminal_rows, terminal_columns = rows, columns
    screen.resize(lines=rows, columns=columns)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    pump(0.8)

def check_frame(name):
    lines = screen.display
    if "DEBEROPA" not in lines[0]: failures.append(name + ": header moved")
    if "Mock Model" not in lines[-1]: failures.append(name + ": status bar moved")
    if not any("❯" in line or "! " in line for line in lines[-5:-2]): failures.append(name + ": prompt moved")
    if not 0 <= screen.cursor.y < terminal_rows: failures.append(name + ": cursor outside screen")

def save_frame(name):
    directory = os.environ.get("SCREEN_DIR")
    if directory:
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, name + ".txt"), "w") as file:
            file.write(text() + f"\nCURSOR {screen.cursor.x},{screen.cursor.y}\n")

try:
    expect("D E B E R O P A", 20)
    if os.environ.get("GIT_REPO"):
        expect("⎇ trunk", 10)
    expect("Ask anything")
    if b"\x1b[?1049h" not in buf: failures.append("alternate screen was not entered")
    check_frame("initial")
    save_frame("initial")
    expect("ctrl+g to send") if os.environ.get("CUSTOM_KEYS") else expect("enter to send")
    send("안녕 read the file")
    from wcwidth import wcswidth
    if screen.cursor.x != 4 + wcswidth("안녕 read the file"): failures.append("wide-character input cursor is misaligned")
    send(submit_key, 0.2)
    expect("Read")
    expect("완료", 10)
    expect("second item")
    pump(0.5)
    check_frame("reply")
    save_frame("reply")
    send("/")
    expect("/sessions")
    send("\x1b", 0.3)
    send("\x7f", 0.2)
    send("/help", 0.2)
    send(submit_key, 0.6)
    expect("Keys")
    resize(15, 50)
    expect("Keys")
    if "Mock Model" not in screen.display[-1]: failures.append("small help dialog hid the status bar")
    save_frame("help-small")
    resize(32, 100)
    send("\x1b", 0.4)
    # local-model helpers: server report with start hints, and the tool-call check
    send("/local", 0.2)
    send(submit_key, 0.6)
    expect("No local model server answered")
    expect("ollama serve")
    send("\x1b", 0.4)
    send("/toolcheck", 0.2)
    send(submit_key, 0.6)
    expect("Tool calls", 15)
    send("\x1b", 0.4)
    send("edit the notes", 0.2)
    send(submit_key, 0.5)
    expect("Permission required", 10) if os.environ.get("ASK_EDIT") else expect("Write", 10)
    if os.environ.get("ASK_EDIT"):
        resize(15, 50)
        expect("Allow once")
        expect("Always")
        if "Mock Model" not in screen.display[-1]: failures.append("small permission dialog hid the status bar")
        save_frame("permission-small")
        resize(32, 100)
        send("y", 0.5)
    if os.environ.get("GIT_REPO"):
        expect("1 changed", 10)  # the file the agent wrote shows up in the status bar
    if os.environ.get("ASK_EDIT"):
        expect("Write", 10)
    pump(1.5)
    check_frame("second reply")
    send("\x1b[5~")
    expect("rows below")
    save_frame("history")
    send("\x1b[1;5F")
    expect("PgUp / PgDn")
    check_frame("scroll bottom")
    resize(18, 60)
    check_frame("small terminal")
    save_frame("small")
    resize(40, 160)
    check_frame("large terminal")
    save_frame("large")
    resize(32, 100)
    send("long fixture")
    send(submit_key)
    expect("HISTORY 100", 15)
    pump(0.5)
    check_frame("long reply")
    save_frame("long")
    send("\x1b[5~")
    expect("rows below")
    if "HISTORY 100" in text(): failures.append("history did not scroll")
    check_frame("history scrolling")
    send("\x1b[1;5H")
    expect("D E B E R O P A")
    send("\x1b[1;5F")
    expect("HISTORY 100")
    send("/new")
    send(submit_key)
    expect("D E B E R O P A")
    if "HISTORY 100" in text(): failures.append("new session retained the old conversation")
    check_frame("new session")
    send("/editor")
    send(submit_key)
    expect("editor fixture")
    check_frame("editor returned")
    if buf.count(b"\x1b[?1049h") < 2 or b"\x1b[?1049l" not in buf: failures.append("editor did not hand off and restore the screen")
    send("\x03")  # clear the editor's returned draft
    if os.environ.get("SIGNAL_EXIT"):
        os.kill(pid, signal.SIGTERM)
    else:
        send("\x04", 0.5)
    pump(1.5)
    if b"\x1b[?1049l" not in buf: failures.append("alternate screen was not restored")

except OSError as e:
    failures.append(f'terminal closed early: {e}')

out = ANSI.sub(b"", buf).decode("utf-8", "replace")
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
