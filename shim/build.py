import subprocess, sys, collections
node_bin = sys.argv[1]
out = subprocess.run(['readelf', '--dyn-syms', '-W', node_bin],
                     capture_output=True, text=True).stdout
by_ver = collections.defaultdict(set)
for line in out.splitlines():
    f = line.split()
    if len(f) < 8 or f[6] != 'UND':
        continue
    name = f[7]
    if not name.startswith('snd_'):
        continue
    n, v = (name.split('@', 1) + ['ALSA_0.9'])[:2] if '@' in name else (name, 'ALSA_0.9')
    by_ver[v].add(n)

src = ('/* Stub ALSA symbols so node-web-audio-api can be dlopen()ed in a sandbox\n'
       ' * with no sound hardware and no root to install libasound2.\n'
       ' * Generated from the binary\'s own undefined-symbol table. */\n\n'
       'void alsa_stub_anchor(void) { }\n')
for n in sorted(set().union(*by_ver.values())):
    src += 'long %s(void) { return 0; }\n' % n
open('libasound.c', 'w').write(src)

v, prev = '', None
for ver in ['ALSA_0.9', 'ALSA_0.9.0rc4', 'ALSA_0.9.0rc8']:
    v += '%s {\n  global:\n' % ver
    for n in sorted(by_ver.get(ver, ())):
        v += '    %s;\n' % n
    v += '    alsa_stub_anchor;\n  local: *;\n}' + (' %s;\n' % prev if prev else ';\n')
    prev = ver
open('ver.map', 'w').write(v)
