import type { ButtonHTMLAttributes } from 'react';

// Reusable button.
//   primary   : blue background, white text, large (main action)
//   secondary : simple text without background (discreet action, e.g. [ESC])
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
};

export default function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, className].filter(Boolean).join(' ');
  // eslint-disable-next-line react/button-has-type
  return <button type={type} className={classes} {...props} />;
}
