type SailingLoaderProps = {
  label: string;
  compact?: boolean;
};

export function SailingLoader({ label, compact = false }: SailingLoaderProps) {
  return (
    <div
      className={`sailing-loader${compact ? ' sailing-loader--compact' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="sailing-loader__scene" aria-hidden="true">
        <div className="sailing-loader__orbit">
          <span className="sailing-loader__dot sailing-loader__dot--1" />
          <span className="sailing-loader__dot sailing-loader__dot--2" />
          <span className="sailing-loader__dot sailing-loader__dot--3" />
        </div>

        <svg
          className="sailing-loader__boat"
          viewBox="0 0 64 64"
          focusable="false"
        >
          <path
            className="sailing-loader__sail sailing-loader__sail--left"
            d="M30 14v23H15z"
          />
          <path
            className="sailing-loader__sail sailing-loader__sail--right"
            d="M34 17v20h15z"
          />
          <path
            className="sailing-loader__mast"
            d="M32 11v29"
          />
          <path
            className="sailing-loader__hull"
            d="M13 39h38l-7 11H21z"
          />
          <path
            className="sailing-loader__wave"
            d="M13 54c5 3 10 3 15 0s10-3 15 0 10 3 15 0"
          />
        </svg>
      </div>

      <span className="sailing-loader__label">{label}</span>
    </div>
  );
}