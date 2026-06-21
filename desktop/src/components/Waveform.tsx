import React, { useMemo } from "react";

interface WaveformProps {
  levels: number[];
}

const BAR_COUNT = 32;

const Waveform: React.FC<WaveformProps> = ({ levels }) => {
  const bars = useMemo(() => {
    const latest = levels.slice(-BAR_COUNT);
    return Array.from({ length: BAR_COUNT }, (_, i) => {
      const sourceIndex = i - (BAR_COUNT - latest.length);
      const value = sourceIndex >= 0 ? latest[sourceIndex] : 0;
      const v = Math.min(Math.max(value ?? 0, 0), 1);

      // Boost low levels so quiet speech is still visible.
      const boosted = Math.pow(v, 0.55);
      const height = Math.max(boosted * 0.96 + 0.04, 0.06);

      return { key: i, height };
    });
  }, [levels]);

  return (
    <div className="waveform" aria-label="Audio waveform">
      {bars.map((bar) => (
        <div
          key={bar.key}
          className="waveform-bar"
          style={{ height: `${bar.height * 100}%` }}
        />
      ))}
    </div>
  );
};

export default Waveform;
