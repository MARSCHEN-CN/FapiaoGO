import React from 'react';

export default function Toggle({ checked, onChange, disabled = false }) {
  return (
    <label
      className="toggle-switch"
      onClick={(e) => e.stopPropagation()}
      style={disabled ? { opacity: 0.4, cursor: 'not-allowed', pointerEvents: disabled ? 'none' : undefined } : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange && onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-track" />
      <span className="toggle-thumb" />
    </label>
  );
}
