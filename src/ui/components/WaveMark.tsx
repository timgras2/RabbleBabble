// The static form of the level meter: the app's one memorable mark. Same
// seven-bar silhouette the live meter draws, so the header and the recording
// state read as the same object.
const BAR_HEIGHTS = [5, 9, 15, 19, 15, 9, 5];

interface WaveMarkProps {
  readonly size?: number;
}

export function WaveMark({ size = 20 }: WaveMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" fill="none" aria-hidden="true">
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={index}
          x={index * 3 + 1}
          y={(21 - height) / 2}
          width="1.8"
          height={height}
          rx="0.9"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
