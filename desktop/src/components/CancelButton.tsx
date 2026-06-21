import React from "react";

interface CancelButtonProps {
  onCancel: () => void;
}

const CancelButton: React.FC<CancelButtonProps> = ({ onCancel }) => (
  <button className="cancel-button" type="button" onClick={onCancel}>
    Cancel
  </button>
);

export default CancelButton;
