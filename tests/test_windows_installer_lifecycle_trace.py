"""Execute NSIS hook control flow against simulated files/SCM/helper outputs.

This is a deliberately restricted interpreter of the instructions used in the
actual hook, not Windows/NSIS execution. Unknown instructions fail the test.
No executable, service, certificate store or registry is touched.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


class HookAbort(Exception):
    pass


def trace_hook(macro, *, certificate=False, stop_at=0, foreign=False, qc_code=0, query_code=0, install_dir=r'C:\Program Files\Yaseir', binary_path=None):
    source = (ROOT / 'src-tauri/installer_hooks.nsh').read_text()
    body = source.split(f'!macro {macro}', 1)[1].split('!macroend', 1)[0].splitlines()[1:]
    replacements = {'name': 'YaseirAgent', 'exe': 'YaseirAgent.exe', 'tag': 'test'}
    instructions, labels = [], {}
    for line in body:
        line = line.strip()
        if not line or line.startswith(';'):
            continue
        for key, value in replacements.items():
            line = line.replace('${' + key + '}', value)
        if line.endswith(':'):
            labels[line[:-1]] = len(instructions)
        else:
            instructions.append(line)
    variables = {'$INSTDIR': install_dir, '$SYSDIR': r'C:\Windows\System32'}
    files = {install_dir + r'\resources\YaseirAgent.exe'}
    if certificate:
        files.add(install_dir + r'\resources\yaseir-public.cer')
    stack, commands = [], []
    elapsed, pc, steps = 0, 0, 0

    def value(token):
        if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
            token = token[1:-1]
        for escaped, actual in [('\\t', '\t'), ('\\r', '\r'), ('\\n', '\n'), ('\\"', '"')]:
            token = token.replace('$' + escaped, actual)
        return re.sub(r'\$(?:INSTDIR|SYSDIR|R\d|\d)', lambda m: variables.get(m[0], ''), token)

    def jump(target, current):
        if target == '0':
            return current + 1
        if target.startswith(('+', '-')):
            return current + int(target)
        return labels[target]

    while pc < len(instructions):
        steps += 1
        assert steps < 3000, 'hook failed to terminate'
        line = instructions[pc]
        tokens = re.findall(r'"(?:\$\\"|[^"])*"|\x27[^\x27]*\x27|\S+', line)
        op, args = tokens[0], tokens[1:]
        next_pc = pc + 1
        if op == 'nsExec::ExecToStack':
            command = value(args[0]); commands.append(command)
            if 'sc.exe" qc ' in command:
                image = r'C:\Foreign\Agent.exe' if foreign else install_dir + r'\resources\YaseirAgent.exe'
                command_line = binary_path if binary_path is not None else '"' + image + '" -service run'
                code, output = qc_code, 'BINARY_PATH_NAME : ' + command_line + '\r\n'
            elif 'sc.exe" query ' in command:
                code, output = query_code, 'STATE : ' + ('1 STOPPED' if elapsed >= stop_at else '3 STOP_PENDING')
            else:
                code, output = 0, 'fixture helper succeeded'
            stack.extend([output, str(code)])
        elif op == 'Pop':
            variables[args[0]] = stack.pop()
        elif op == 'StrCpy':
            val = value(args[1]); offset = int(value(args[3])) if len(args) > 3 else 0
            length = value(args[2]) if len(args) > 2 else ''
            variables[args[0]] = val[offset:][:int(length)] if length else val[offset:]
        elif op == 'StrLen':
            variables[args[0]] = str(len(value(args[1])))
        elif op == '${StrStr}':
            haystack, needle = value(args[1]), value(args[2])
            pos = haystack.find(needle)
            variables[args[0]] = '' if pos < 0 else haystack[pos:]
        elif op == 'StrCmp':
            same = value(args[0]).casefold() == value(args[1]).casefold()
            target = args[2] if same else (args[3] if len(args) > 3 else '0')
            next_pc = jump(target, pc)
        elif op == 'IntCmp':
            left, right = int(value(args[0])), int(value(args[1]))
            next_pc = jump(args[2 if left == right else 3 if left < right else 4], pc)
        elif op == 'IntOp':
            assert args[2] == '+'
            variables[args[0]] = str(int(value(args[1])) + int(value(args[3])))
        elif op == 'IfFileExists':
            next_pc = jump(args[1] if value(args[0]) in files else args[2], pc)
        elif op == 'Goto':
            next_pc = jump(args[0], pc)
        elif op == 'Sleep':
            elapsed += int(value(args[0])) / 1000
        elif op in ('DetailPrint', 'SetErrorLevel'):
            pass
        elif op == 'Abort':
            raise HookAbort(f'{value(args[0])}; simulated elapsed={elapsed}s; commands={commands}')
        else:
            raise AssertionError(f'unsupported NSIS instruction: {line}')
        pc = next_pc
    return commands, elapsed


def test_signed_package_does_not_change_machine_certificate_trust():
    for certificate in [False, True]:
        commands, _ = trace_hook('NSIS_HOOK_POSTINSTALL', certificate=certificate)
        assert not any('certutil.exe' in c.lower() or '-addstore' in c.lower() for c in commands), commands
        assert any('-service install' in c for c in commands)
        assert any('-service start' in c for c in commands)


def test_upgrade_waits_for_agent_shutdown_budget_and_remains_bounded():
    commands, elapsed = trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', stop_at=27)
    assert elapsed == 27
    assert any('sc.exe" stop ' in c for c in commands)
    try:
        trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', stop_at=999)
    except HookAbort as error:
        assert 'still running' in str(error)
        assert 'elapsed=30.0s' in str(error)
    else:
        raise AssertionError('a service that never stops must abort installation')


def test_upgrade_preserves_exact_installation_ownership_gate():
    commands, elapsed = trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', stop_at=0)
    assert elapsed <= 1
    assert any('sc.exe" stop ' in c for c in commands)
    try:
        trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', foreign=True)
    except HookAbort as error:
        assert 'foreign Windows service' in str(error)
        assert 'sc.exe" stop ' not in str(error)
    else:
        raise AssertionError('foreign service must abort installation before stop')


def test_service_absence_uses_exit_status_not_arbitrary_output_digits():
    commands, _ = trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', install_dir=r'C:\Apps\1060\Yaseir')
    assert any('sc.exe" stop ' in c for c in commands), commands
    commands, elapsed = trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', qc_code=1060)
    assert len(commands) == 1 and elapsed == 0
    try:
        trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', qc_code=5, install_dir=r'C:\Apps\1060\Yaseir')
    except HookAbort as error:
        assert 'Unable to verify' in str(error)
    else:
        raise AssertionError('failed ownership query must never pass based on output digits')


def test_failed_query_never_confirms_stopped_state():
    try:
        trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', query_code=5)
    except HookAbort as error:
        assert 'still running' in str(error) or 'Unable to verify' in str(error)
    else:
        raise AssertionError('STOPPED text from a failed query is not service-state evidence')


def test_upgrade_rejects_ambiguous_or_malformed_executable_before_stopping():
    image = r'C:\Program Files\Yaseir\resources\YaseirAgent.exe'
    for command_line in [
        image + ' -service run',  # unquoted spaces do not identify this executable
        '"' + image,  # unterminated executable token
        image + '" -service run',  # unmatched trailing quote
        '"' + image + '"" -service run',
        '"' + image + '"other.exe -service run',
        '"' + image + '.foreign" -service run',
        ':"' + image + '" -service run',  # separator-like bytes are part of the path
    ]:
        try:
            trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', binary_path=command_line)
        except HookAbort as error:
            assert 'foreign Windows service' in str(error)
            assert 'sc.exe" stop ' not in str(error), command_line
        else:
            raise AssertionError(f'unverified executable must abort before stop: {command_line}')


def test_upgrade_accepts_exact_quoted_and_unquoted_executable_tokens():
    for install_dir, command_line in [
        (r'C:\Program Files\Yaseir', r'"C:\Program Files\Yaseir\resources\YaseirAgent.exe" -service run'),
        (r'C:\Program Files\Yaseir', r'"C:\Program Files\Yaseir\YaseirAgent.exe"'),
        (r'C:\Apps\Yaseir', r'C:\Apps\Yaseir\resources\YaseirAgent.exe -service run'),
        (r'C:\Apps\Yaseir', r'C:\Apps\Yaseir\YaseirAgent.exe'),
    ]:
        commands, _ = trace_hook('YASEIR_STOP_OWNED_SERVICE_VERIFY', install_dir=install_dir, binary_path=command_line)
        assert any('sc.exe" stop ' in command for command in commands), command_line
