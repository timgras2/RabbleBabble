import { useEffect, useRef } from "react";
import type { AudioRecorder } from "../../platform/audio/types";

const BAR_COUNT = 7;
// Middle bars react most, so the shape reads as a voice rather than a bar chart.
const BAR_WEIGHTS = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];
const IDLE_SCALE = 0.12;

interface LevelMeterProps {
  readonly recorder: AudioRecorder;
  readonly active: boolean;
}

/**
 * Proof the app is hearing you -- a pulsing dot only says "recording".
 * Animates by writing transforms straight to the DOM: at 60fps React state
 * would re-render the whole screen for every frame.
 */
export function LevelMeter({ recorder, active }: LevelMeterProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const reduceMotion =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      return;
    }

    let frame = 0;
    let smoothed = 0;

    const draw = () => {
      const level = recorder.getInputLevel() ?? 0;
      // Rise fast so a word registers immediately, fall slowly so it stays readable.
      smoothed = level > smoothed ? level : smoothed * 0.82 + level * 0.18;
      for (let index = 0; index < BAR_COUNT; index += 1) {
        const bar = barsRef.current[index];
        if (bar) {
          bar.style.transform = `scaleY(${IDLE_SCALE + smoothed * BAR_WEIGHTS[index] * (1 - IDLE_SCALE)})`;
        }
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, recorder]);

  return (
    <div className={`level-meter${active ? " level-meter--active" : ""}`} aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className="level-meter__bar"
          ref={(node) => {
            barsRef.current[index] = node;
          }}
        />
      ))}
    </div>
  );
}
