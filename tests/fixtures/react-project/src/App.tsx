import React, { useState } from 'react';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { Modal } from './components/Modal';

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div className="app">
      <Card title="Welcome">
        <p>This is the main application.</p>
        <Button label="Open Modal" onClick={() => setIsModalOpen(true)} />
      </Card>
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)}>
        <Card title="Modal Content">
          <p>This is inside the modal.</p>
          <Button label="Close" onClick={() => setIsModalOpen(false)} variant="secondary" />
        </Card>
      </Modal>
    </div>
  );
}