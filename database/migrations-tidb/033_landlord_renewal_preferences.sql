CREATE TABLE IF NOT EXISTS landlord_renewal_preferences (
  id BIGINT NOT NULL AUTO_INCREMENT,
  landlord_user_id BIGINT NOT NULL,
  unchanged_terms_negotiable TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_landlord_renewal_preferences_user (landlord_user_id)
);
