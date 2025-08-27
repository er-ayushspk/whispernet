import argparse
from typing import List

import numpy as np
import sounddevice as sd

from bfsk import BfskConfig, demodulate_bfsk


def main(argv: List[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description="WhisperNet BFSK Receiver")
	parser.add_argument("--rate", type=int, default=400, dest="symbol_rate")
	parser.add_argument("--f0", type=float, default=3200.0)
	parser.add_argument("--f1", type=float, default=4200.0)
	parser.add_argument("--sr", type=int, default=48000, dest="sample_rate")
	args = parser.parse_args(argv)

	cfg = BfskConfig(sample_rate=args.sample_rate, f0=args.f0, f1=args.f1, symbol_rate=args.symbol_rate)
	print(f"Listening at {cfg.sample_rate} Hz, {cfg.symbol_rate} Bd, f0={cfg.f0} f1={cfg.f1}")

	block_size = cfg.samples_per_symbol * 32
	with sd.InputStream(channels=1, samplerate=cfg.sample_rate, blocksize=block_size, dtype="float32") as stream:
		buffer = np.empty(0, dtype=np.float32)
		while True:
			block, _ = stream.read(block_size)
			block = block[:, 0]
			buffer = np.concatenate([buffer, block])
			# process in whole symbol strides
			usable = (len(buffer) // cfg.samples_per_symbol) * cfg.samples_per_symbol
			to_process = buffer[:usable]
			buffer = buffer[usable:]
			if usable == 0:
				continue
			decoded = demodulate_bfsk(cfg, to_process)
			if decoded:
				try:
					text = decoded.decode("utf-8", errors="ignore")
					print(f"[RX] {text}")
				except Exception:
					pass


if __name__ == "__main__":
	raise SystemExit(main())


