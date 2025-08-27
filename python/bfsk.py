import math
from dataclasses import dataclass
from typing import Iterable, List

import numpy as np


@dataclass
class BfskConfig:
	sample_rate: int = 48000
	f0: float = 3200.0
	f1: float = 4200.0
	symbol_rate: int = 400
	volume: float = 0.6

	@property
	def samples_per_symbol(self) -> int:
		return max(1, round(self.sample_rate / self.symbol_rate))


def crc16_ibm(data: bytes) -> int:
	crc = 0xFFFF
	for b in data:
		crc ^= b
		for _ in range(8):
			mix = crc & 1
			crc >>= 1
			if mix:
				crc ^= 0xA001
	return crc & 0xFFFF


def frame_message(payload: bytes) -> bytes:
	length = len(payload)
	crc = crc16_ibm(payload)
	return bytes([0x7E, (length >> 8) & 0xFF, length & 0xFF]) + payload + bytes([(crc >> 8) & 0xFF, crc & 0xFF])


def deframe(stream: bytes):
	messages: List[bytes] = []
	i = 0
	while i + 5 <= len(stream):
		if stream[i] != 0x7E:
			i += 1
			continue
		length = (stream[i + 1] << 8) | stream[i + 2]
		end = i + 1 + 2 + length + 2
		if end > len(stream):
			break
		payload = stream[i + 3 : i + 3 + length]
		crc_got = (stream[end - 2] << 8) | stream[end - 1]
		if crc16_ibm(payload) == crc_got:
			messages.append(payload)
			i = end
		else:
			i += 1
	return messages, stream[i:]


def bytes_to_bits(data: bytes) -> np.ndarray:
	bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
	return bits


def synthesize_bfsk(config: BfskConfig, bits: Iterable[int]) -> np.ndarray:
	bits_arr = np.array(list(bits), dtype=np.int32)
	sps = config.samples_per_symbol
	num_samples = len(bits_arr) * sps
	t = np.arange(sps, dtype=np.float32) / config.sample_rate
	wave = np.empty(num_samples, dtype=np.float32)
	phase0_inc = 2.0 * math.pi * config.f0 / config.sample_rate
	phase1_inc = 2.0 * math.pi * config.f1 / config.sample_rate
	phase = 0.0
	idx = 0
	for bit in bits_arr:
		inc = phase1_inc if bit == 1 else phase0_inc
		# generate sps samples continuing phase
		for _ in range(sps):
			wave[idx] = math.sin(phase) * config.volume
			phase += inc
			idx += 1
	return wave


def goertzel_power(block: np.ndarray, freq: float, sample_rate: int) -> float:
	k = int(0.5 + (len(block) * freq) / sample_rate)
	w = (2.0 * math.pi / len(block)) * k
	cos_w = math.cos(w)
	sin_w = math.sin(w)
	coeff = 2.0 * cos_w
	q0 = 0.0
	q1 = 0.0
	q2 = 0.0
	for x in block:
		q0 = coeff * q1 - q2 + x
		q2 = q1
		q1 = q0
	real = q1 - q2 * cos_w
	imag = q2 * sin_w
	return real * real + imag * imag


def demodulate_bfsk(config: BfskConfig, samples: np.ndarray) -> bytes:
	sps = config.samples_per_symbol
	bit_bytes: List[int] = []
	byte_acc = 0
	bit_count = 0
	framed = b""
	messages: List[bytes] = []
	for start in range(0, len(samples) - sps + 1, sps):
		block = samples[start : start + sps]
		p0 = goertzel_power(block, config.f0, config.sample_rate)
		p1 = goertzel_power(block, config.f1, config.sample_rate)
		bit = 1 if p1 > p0 else 0
		byte_acc = ((byte_acc << 1) | bit) & 0xFF
		bit_count += 1
		if bit_count == 8:
			bit_bytes.append(byte_acc)
			framed += bytes([byte_acc])
			msgs, remainder = deframe(framed)
			messages.extend(msgs)
			framed = remainder
			bit_count = 0
			byte_acc = 0
	return b"".join(messages)


