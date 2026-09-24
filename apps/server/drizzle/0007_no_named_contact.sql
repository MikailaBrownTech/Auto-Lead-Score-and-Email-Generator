-- needs_direct_contact is now no_named_contact (a warning, not a block).
UPDATE `leads` SET `status` = 'no_named_contact' WHERE `status` = 'needs_direct_contact';
