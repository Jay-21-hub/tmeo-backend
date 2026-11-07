import React, { useState, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import { Camera, MapPin, Clock, User, AlertCircle, RefreshCw, ZoomIn } from 'lucide-react';
import { evidenceService } from '../../services/evidenceService';
import ImageLightbox from './ImageLightbox';
import LoadingSpinner from './LoadingSpinner';

/**
 * Reusable read-only Evidence Viewer Grid.
 * Fetches and presents ViolationEvidence photos in a responsive grid.
 * Integrates with ImageLightbox for full-screen inspection and metadata view.
 */
const EvidenceViewerGrid = ({ violationId, title = 'Attached Evidence Photos' }) => {
  const [evidenceList, setEvidenceList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeLightboxIndex, setActiveLightboxIndex] = useState(null);

  const fetchEvidence = useCallback(async () => {
    if (!violationId) {
      setEvidenceList([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await evidenceService.getViolationEvidence(violationId);
      setEvidenceList(data);
    } catch (err) {
      console.error('Failed to load evidence photos:', err);
      setError('Unable to load attached evidence photos.');
    } finally {
      setLoading(false);
    }
  }, [violationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/prop-change pattern, same convention used elsewhere in this codebase
    fetchEvidence();
  }, [violationId, fetchEvidence]);

  const handleOpenLightbox = (index) => {
    setActiveLightboxIndex(index);
  };

  const handleCloseLightbox = () => {
    setActiveLightboxIndex(null);
  };

  // Format evidence items for ImageLightbox integration
  const lightboxImages = evidenceList.map((item) => ({
    url: item.image_url || item.image,
    title: `Evidence #${item.id}`,
    caption: `Captured by ${item.captured_by_name || 'Enforcer'} on ${
      item.captured_at ? new Date(item.captured_at).toLocaleString() : 'N/A'
    }`,
    capturedAt: item.captured_at,
    capturedBy: item.captured_by_name,
    latitude: item.latitude,
    longitude: item.longitude,
  }));

  return (
    <div className="space-y-3 my-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Camera className="w-4 h-4 text-slate-500" />
          <span>{title}</span>
          {!loading && !error && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
              {evidenceList.length}
            </span>
          )}
        </h4>
      </div>

      {/* State 1: Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-8 bg-slate-50 rounded-lg border border-slate-200 border-dashed">
          <LoadingSpinner size="sm" />
          <span className="text-xs text-slate-500 mt-2">Loading evidence photos...</span>
        </div>
      )}

      {/* State 2: Error State */}
      {!loading && error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg flex items-center justify-between text-rose-700 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={fetchEvidence}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white text-rose-700 border border-rose-300 rounded hover:bg-rose-50 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}

      {/* State 3: Empty State */}
      {!loading && !error && evidenceList.length === 0 && (
        <div className="text-center py-6 bg-slate-50 rounded-lg border border-slate-200 border-dashed p-4">
          <Camera className="w-8 h-8 mx-auto text-slate-300 mb-2" />
          <p className="text-xs font-medium text-slate-600">No evidence photos attached</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            This violation record does not have secondary photos attached.
          </p>
        </div>
      )}

      {/* State 4: Evidence Grid Available */}
      {!loading && !error && evidenceList.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {evidenceList.map((item, index) => {
            const imageUrl = item.image_url || item.image;
            const capturedDate = item.captured_at
              ? new Date(item.captured_at).toLocaleDateString()
              : null;
            const capturedTime = item.captured_at
              ? new Date(item.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : null;

            return (
              <div
                key={item.id || index}
                onClick={() => handleOpenLightbox(index)}
                className="group relative bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm hover:shadow-md hover:border-blue-400 cursor-pointer transition-all flex flex-col"
              >
                {/* Image Aspect Box */}
                <div className="relative aspect-[4/3] bg-slate-100 overflow-hidden">
                  <img
                    src={imageUrl}
                    alt={`Evidence ${item.id || index + 1}`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-slate-900/0 group-hover:bg-slate-900/20 transition-colors flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-slate-900/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity transform scale-90 group-hover:scale-100">
                      <ZoomIn className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* Metadata Card Footer */}
                <div className="p-2.5 bg-white text-[11px] text-slate-600 space-y-1 border-t border-slate-100">
                  {item.captured_by_name && (
                    <div className="flex items-center gap-1.5 text-slate-700 font-medium truncate">
                      <User className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span className="truncate">{item.captured_by_name}</span>
                    </div>
                  )}

                  {capturedDate && (
                    <div className="flex items-center gap-1.5 text-slate-500">
                      <Clock className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span>
                        {capturedDate} {capturedTime}
                      </span>
                    </div>
                  )}

                  {item.latitude && item.longitude && (
                    <div className="flex items-center gap-1.5 text-slate-500 truncate">
                      <MapPin className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span className="font-mono text-[10px] truncate">
                        {Number(item.latitude).toFixed(4)}, {Number(item.longitude).toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox Integration */}
      {activeLightboxIndex !== null && (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={activeLightboxIndex}
          onClose={handleCloseLightbox}
        />
      )}
    </div>
  );
};

EvidenceViewerGrid.propTypes = {
  violationId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  title: PropTypes.string,
};

export default EvidenceViewerGrid;