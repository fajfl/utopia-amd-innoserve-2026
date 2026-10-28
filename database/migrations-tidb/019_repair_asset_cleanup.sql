UPDATE rental_unit_assets SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
WHERE asset_name IN ('養寵物', '開伙') OR asset_name LIKE '%不可%' OR asset_name LIKE '%租金%'
   OR asset_name LIKE '%最短租期%' OR asset_name LIKE '%身份要求%';
