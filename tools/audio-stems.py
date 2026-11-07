import wave, numpy as np
SR=48000
def load(p):
    w=wave.open(p); n=w.getnframes()
    return np.frombuffer(w.readframes(n),dtype=np.int16).reshape(-1,2).astype(np.float32)/32768
def write(p,d):
    d=np.clip(d,-1,1); i=(d*32767).astype(np.int16)
    w=wave.open(p,'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(i.tobytes()); w.close()
full=load('qa-out/audio/ninja-battle-full-mix.wav')
music=load('/tmp/q0.wav')
for k,t in [('q64',64),('q128',128),('q192',192)]: pass
# concatenate the 4 music-only quarters
parts=[load(f'/tmp/q{t}.wav') for t in (0,64,128,192)]
music=np.concatenate(parts)
m=min(len(full),len(music)); full=full[:m]; music=music[:m]
import os
os.makedirs('qa-out/stems',exist_ok=True)
write('qa-out/stems/ninja-battle-music.wav', music)
write('qa-out/stems/ninja-battle-sfx-plus-voice.wav', full-music)
def stat(name,d):
    rms=20*np.log10(np.sqrt((d**2).mean())+1e-12)
    pk=20*np.log10(np.abs(d).max()+1e-12)
    print(f"{name:28s} rms {rms:7.1f} dBFS  peak {pk:7.1f} dBFS")
stat('full mix',full); stat('music bed',music); stat('sfx+voice (residual)',full-music)
