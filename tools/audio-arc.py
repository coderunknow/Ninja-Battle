import wave, numpy as np, sys
w=wave.open(sys.argv[1]); sr=w.getframerate(); n=w.getnframes()
d=np.frombuffer(w.readframes(n),dtype=np.int16).reshape(-1,2).astype(np.float64)/32768
m=d.mean(axis=1)
win=int(sr*4)
print(f"{'t(s)':>6} {'LWUFS-style':>11} {'rms dBFS':>9}  bar")
for i in range(0,len(m)-win+1,win):
    seg=m[i:i+win]
    rms=20*np.log10(np.sqrt((seg**2).mean())+1e-12)
    # crude K-weighting proxy: +4 dB above 1.5k, +2 dB below 100
    S=np.abs(np.fft.rfft(seg*np.hanning(len(seg))))**2
    fr=np.fft.rfftfreq(len(seg),1/sr)
    wt=np.ones_like(fr); wt[fr<100]=1.6; wt[fr>1500]=2.5
    lufs=10*np.log10((S*wt).sum()/len(seg)*2+1e-12)-3
    bar='#'*int(max(0,(lufs+40))*1.2)
    print(f"{i/sr:6.0f} {lufs:11.1f} {rms:9.1f}  {bar}")
