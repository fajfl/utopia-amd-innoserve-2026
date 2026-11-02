CREATE TABLE IF NOT EXISTS rent_negotiations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(191) NOT NULL,
  inquiry_id BIGINT NOT NULL,
  source_message_id BIGINT NULL,
  listed_rent_amount INT NOT NULL,
  offered_rent_amount INT NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  counter_rent_amount INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rent_negotiations_public_id (public_id),
  KEY idx_rent_negotiations_inquiry (inquiry_id, outcome),
  CONSTRAINT fk_rent_negotiations_inquiry FOREIGN KEY (inquiry_id) REFERENCES inquiries(id),
  CONSTRAINT fk_rent_negotiations_message FOREIGN KEY (source_message_id) REFERENCES messages(id),
  CONSTRAINT chk_rent_negotiations_amounts CHECK (listed_rent_amount > 0 AND offered_rent_amount > 0
    AND counter_rent_amount > 0),
  CONSTRAINT chk_rent_negotiations_outcome CHECK (outcome IN ('accepted', 'countered', 'declined', 'escalated')),
  CONSTRAINT chk_rent_negotiations_counter CHECK ((outcome = 'countered') = (counter_rent_amount IS NOT NULL))
);
