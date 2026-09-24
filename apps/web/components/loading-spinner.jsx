'use client';

import styles from './loading-spinner.module.css';

export default function LoadingSpinner({ text = 'Loading...' }) {
  return (
    <div className={styles.container}>
      <img src="/assets/spinner.gif" alt="Loading" className={styles.spinner} />
      {text && <p className={styles.text}>{text}</p>}
    </div>
  );
}
