export function Field({
  label,
  name,
  children,
  hint,
  required,
  className = '',
}: {
  label: string
  name?: string
  children: React.ReactNode
  hint?: string
  required?: boolean
  className?: string
}) {
  return (
    <div className={className}>
      <label htmlFor={name}>
        {label}
        {required && <span className="ml-1 text-clay">*</span>}
      </label>
      {children}
      {hint && <p className="hint mt-1">{hint}</p>}
    </div>
  )
}
