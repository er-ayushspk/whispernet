import argparse
from typing import List

import numpy as np
import sounddevice as sd

from bfsk import BfskConfig, bytes_to_bits, frame_message, synthesize_bfsk


def main(argv: List[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description="WhisperNet BFSK Transmitter")
	parser.add_argument("message", help="Text message to send")
	parser.add_argument("--rate", type=int, default=400, dest="symbol_rate")
	parser.add_argument("--f0", type=float, default=3200.0)
	parser.add_argument("--f1", type=float, default=4200.0)
	parser.add_argument("--sr", type=int, default=48000, dest="sample_rate")
	parser.add_argument("--volume", type=float, default=0.6)
	args = parser.parse_args(argv)

	cfg = BfskConfig(sample_rate=args.sample_rate, f0=args.f0, f1=args.f1, symbol_rate=args.symbol_rate, volume=args.volume)
	payload = args.message.encode("utf-8")
	framed = frame_message(payload)
	# preamble: 64 bits alternating 0/1 for coarse sync
	preamble = np.fromiter(((i % 2) for i in range(64)), dtype=np.int32)
	bits = np.concatenate([preamble, bytes_to_bits(framed)])
	wave = synthesize_bfsk(cfg, bits)
	print(f"Transmitting {len(payload)} bytes at {cfg.symbol_rate} Bd, f0={cfg.f0}Hz f1={cfg.f1}Hz")
	sd.play(wave, samplerate=cfg.sample_rate, blocking=True)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())


