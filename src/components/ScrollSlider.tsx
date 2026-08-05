'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

interface ScrollSliderProps {
  /** Ref to the scrollable container element */
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Custom horizontal scrollbar slider.
 *
 * Renders a track + draggable thumb below a scrollable container.
 * Syncs bidirectionally: dragging the thumb scrolls the container,
 * scrolling the container (wheel / trackpad / touch) moves the thumb.
 *
 * Auto-hides when content fits without overflow.
 * Thumb has a 30 px minimum width so it stays grabbable on narrow viewports.
 */
export function ScrollSlider({ containerRef }: ScrollSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(30);
  const [thumbLeft, setThumbLeft] = useState(0);
  const [visible, setVisible] = useState(false);

  // Drag state stored in refs to avoid re-render overhead during drag
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartLeft = useRef(0);

  // ----- Thumb geometry update -----

  const updateThumb = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollWidth, clientWidth } = container;

    // Hide when content fits
    if (scrollWidth <= clientWidth + 1) {
      setVisible(false);
      return;
    }

    const track = trackRef.current;
    if (!track) {
      // Track DOM not yet painted – mark visible so it renders, then re-measure
      setVisible(true);
      return;
    }

    setVisible(true);

    const trackWidth = track.clientWidth;
    const { scrollLeft } = container;

    // Thumb width proportional to visible ratio, floor at 30 px
    const ratio = clientWidth / scrollWidth;
    const w = Math.max(30, trackWidth * ratio);
    setThumbWidth(w);

    // Thumb position proportional to scroll position
    const maxScrollLeft = scrollWidth - clientWidth;
    const maxThumbLeft = trackWidth - w;
    const left = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
    setThumbLeft(left);
  }, [containerRef]);

  // ----- Observe container size & scroll -----

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateThumb();

    const ro = new ResizeObserver(() => updateThumb());
    ro.observe(container);
    container.addEventListener('scroll', updateThumb, { passive: true });

    return () => {
      ro.disconnect();
      container.removeEventListener('scroll', updateThumb);
    };
  }, [containerRef, updateThumb]);

  // Re-measure after track DOM appears (visible false → true)
  useEffect(() => {
    if (visible) {
      const id = requestAnimationFrame(() => updateThumb());
      return () => cancelAnimationFrame(id);
    }
  }, [visible, updateThumb]);

  // ----- Scroll sync helpers -----

  const scrollContainerTo = useCallback(
    (thumbPos: number) => {
      const container = containerRef.current;
      const track = trackRef.current;
      if (!container || !track) return;

      const maxThumbLeft = track.clientWidth - thumbWidth;
      const ratio = maxThumbLeft > 0 ? thumbPos / maxThumbLeft : 0;
      const maxScrollLeft = container.scrollWidth - container.clientWidth;
      container.scrollLeft = ratio * maxScrollLeft;
    },
    [containerRef, thumbWidth],
  );

  // ----- Track click (jump-to-position) -----

  const handleTrackClick = (e: React.MouseEvent) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newThumbLeft = Math.max(
      0,
      Math.min(rect.width - thumbWidth, clickX - thumbWidth / 2),
    );
    scrollContainerTo(newThumbLeft);
  };

  // ----- Thumb mouse drag -----

  const handleThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartLeft.current = thumbLeft;
  };

  // ----- Thumb touch drag -----

  const handleThumbTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    dragging.current = true;
    dragStartX.current = e.touches[0].clientX;
    dragStartLeft.current = thumbLeft;
  };

  // ----- Global move / up listeners -----

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const container = containerRef.current;
      const track = trackRef.current;
      if (!container || !track) return;

      const dx = e.clientX - dragStartX.current;
      const maxThumbLeft = track.clientWidth - thumbWidth;
      const newLeft = Math.max(0, Math.min(maxThumbLeft, dragStartLeft.current + dx));

      const ratio = maxThumbLeft > 0 ? newLeft / maxThumbLeft : 0;
      container.scrollLeft = ratio * (container.scrollWidth - container.clientWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging.current) return;
      const container = containerRef.current;
      const track = trackRef.current;
      if (!container || !track) return;

      const dx = e.touches[0].clientX - dragStartX.current;
      const maxThumbLeft = track.clientWidth - thumbWidth;
      const newLeft = Math.max(0, Math.min(maxThumbLeft, dragStartLeft.current + dx));

      const ratio = maxThumbLeft > 0 ? newLeft / maxThumbLeft : 0;
      container.scrollLeft = ratio * (container.scrollWidth - container.clientWidth);
    };

    const onTouchEnd = () => {
      dragging.current = false;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [containerRef, thumbWidth]);

  // ----- Render -----

  if (!visible) return null;

  return (
    <div
      ref={trackRef}
      className="scroll-slider-track"
      onMouseDown={handleTrackClick}
    >
      <div
        className="scroll-slider-thumb"
        style={{
          left: `${thumbLeft}px`,
          width: `${thumbWidth}px`,
        }}
        onMouseDown={handleThumbMouseDown}
        onTouchStart={handleThumbTouchStart}
      />
    </div>
  );
}
