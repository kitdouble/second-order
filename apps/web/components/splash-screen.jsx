'use client';

import { useEffect, useState } from 'react';
import styles from './splash-screen.module.css';

export default function SplashScreen() {
  const [showSplash, setShowSplash] = useState(false);

  useEffect(() => {
    // Check if splash has been shown this session
    if (typeof window !== 'undefined' && !sessionStorage.getItem('splash-shown')) {
      setShowSplash(true);
      sessionStorage.setItem('splash-shown', 'true');
      // Auto-dismiss after 3.5 seconds (covers animation time)
      const timer = setTimeout(() => setShowSplash(false), 3500);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!showSplash) return null;

  return (
    <div className={styles.splash}>
      <div className={styles.container}>
        <img
          src="/assets/welcome_animation.gif"
          alt="Welcome to Second Order"
          className={styles.animation}
        />
      </div>
    </div>
  );
}
