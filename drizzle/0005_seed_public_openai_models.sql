WITH `source_models` AS (
	SELECT `source`.*
	FROM `ai_models` AS `source`
	WHERE `source`.`model_id` = 'gpt-5.3-codex-spark'
		AND `source`.`endpoint` = 'http://8.163.6.244:8317/v1'
		AND `source`.`api_key_ciphertext` IS NOT NULL
		AND `source`.`api_key_iv` IS NOT NULL
		AND `source`.`id` = (
			SELECT `candidate`.`id`
			FROM `ai_models` AS `candidate`
			WHERE `candidate`.`owner_id` = `source`.`owner_id`
				AND `candidate`.`model_id` = `source`.`model_id`
				AND `candidate`.`endpoint` = `source`.`endpoint`
				AND `candidate`.`api_key_ciphertext` IS NOT NULL
				AND `candidate`.`api_key_iv` IS NOT NULL
			ORDER BY `candidate`.`updated_at` DESC, `candidate`.`id` DESC
			LIMIT 1
		)
),
`target_models` (`name`, `model_id`, `level`, `parameters_json`) AS (
	VALUES
		('gpt-5.4', 'gpt-5.4', '标准', '{"capabilities":["text","analysis","剧本创作"]}'),
		('gpt-5.5', 'gpt-5.5', '标准', '{"capabilities":["text","analysis","剧本创作"]}'),
		('gpt-5.6-terra', 'gpt-5.6-terra', '旗舰', '{"capabilities":["text","analysis","剧本创作"]}'),
		('gpt-image-2', 'gpt-image-2', '图像', '{"capabilities":["image-generation","text-to-image"]}'),
		('gpt-5.4-mini', 'gpt-5.4-mini', '轻量', '{"capabilities":["text","analysis","剧本创作"]}'),
		('gpt-5.6-sol', 'gpt-5.6-sol', '旗舰', '{"capabilities":["text","analysis","剧本创作"]}'),
		('gpt-5.6-luna', 'gpt-5.6-luna', '旗舰', '{"capabilities":["text","analysis","剧本创作"]}'),
		('codex-auto-review', 'codex-auto-review', '标准', '{"capabilities":["text","analysis","code-review"]}'),
		('gpt-image-1.5', 'gpt-image-1.5', '图像', '{"capabilities":["image-generation","text-to-image"]}')
)
INSERT INTO `ai_models` (
	`id`, `owner_id`, `name`, `provider`, `model_id`, `level`, `endpoint`, `icon_url`,
	`api_key_ciphertext`, `api_key_iv`, `api_key_hint`, `enabled`, `parameters_json`, `created_at`, `updated_at`
)
SELECT
	'mdl_' || lower(hex(randomblob(16))),
	`source`.`owner_id`,
	`target`.`name`,
	'OpenAI-compatible',
	`target`.`model_id`,
	`target`.`level`,
	`source`.`endpoint`,
	NULL,
	`source`.`api_key_ciphertext`,
	`source`.`api_key_iv`,
	`source`.`api_key_hint`,
	1,
	`target`.`parameters_json`,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `source_models` AS `source`
CROSS JOIN `target_models` AS `target`
WHERE NOT EXISTS (
	SELECT 1
	FROM `ai_models` AS `existing`
	WHERE `existing`.`owner_id` = `source`.`owner_id`
		AND `existing`.`endpoint` = `source`.`endpoint`
		AND `existing`.`model_id` = `target`.`model_id`
);
