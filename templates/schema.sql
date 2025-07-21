-- MySQL dump 10.13  Distrib 8.4.5, for Linux (aarch64)
--
-- Host: localhost    Database: solarmon
-- ------------------------------------------------------
-- Server version	8.4.5

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Current Database: `solarmon`
--

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `solarmon` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

USE `solarmon`;

--
-- Table structure for table `alarms`
--

DROP TABLE IF EXISTS `alarms`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `alarms` (
  `alarm_id` int NOT NULL AUTO_INCREMENT,
  `plant_name` varchar(255) NOT NULL,
  `inverter_id` varchar(255) NOT NULL,
  `alarm_type` varchar(100) NOT NULL,
  `alarm_severity` varchar(50) NOT NULL,
  `problem_details` varchar(255) DEFAULT NULL,
  `detected_value` decimal(10,3) DEFAULT NULL,
  `threshold_value` decimal(10,3) DEFAULT NULL,
  `message` text NOT NULL,
  `triggered_at` datetime NOT NULL,
  `email_uid` varchar(255) DEFAULT NULL,
  `cleared_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `cleared_by` varchar(50) DEFAULT NULL,
  `observation` text,
  PRIMARY KEY (`alarm_id`)
) ENGINE=InnoDB AUTO_INCREMENT=22 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `api_status_monitor`
--

DROP TABLE IF EXISTS `api_status_monitor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_status_monitor` (
  `api_name` varchar(50) NOT NULL COMMENT 'Nome da API (ex: Growatt, Solarman)',
  `status` enum('OK','FAILING') NOT NULL COMMENT 'Status atual da API',
  `first_failure_at` datetime NOT NULL COMMENT 'Timestamp da primeira falha consecutiva',
  `last_checked_at` datetime NOT NULL COMMENT 'Timestamp da última verificação',
  `notification_sent` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Flag para indicar se a notificação de falha persistente já foi enviada',
  `recovery_grace_period_until` datetime DEFAULT NULL COMMENT 'Timestamp até o qual os alarmes para esta API devem ser ignorados após uma recuperação.',
  PRIMARY KEY (`api_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `consecutive_alarm_counts`
--

DROP TABLE IF EXISTS `consecutive_alarm_counts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `consecutive_alarm_counts` (
  `plant_name` varchar(30) NOT NULL,
  `inverter_id` varchar(30) NOT NULL,
  `alarm_type` varchar(50) NOT NULL,
  `consecutive_count` int DEFAULT '0',
  `last_detected_at` datetime DEFAULT NULL,
  `problem_details` varchar(255) NOT NULL,
  PRIMARY KEY (`plant_name`,`inverter_id`,`alarm_type`,`problem_details`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `growatt_event_diagnostics`
--

DROP TABLE IF EXISTS `growatt_event_diagnostics`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `growatt_event_diagnostics` (
  `id` int NOT NULL AUTO_INCREMENT,
  `plant_name` varchar(255) NOT NULL,
  `inverter_id` varchar(255) NOT NULL,
  `event_description` varchar(255) NOT NULL,
  `captured_at` datetime NOT NULL,
  `warn_code` int DEFAULT NULL,
  `pid_fault_code` int DEFAULT NULL,
  `warn_bit` int DEFAULT NULL,
  `warn_code1` int DEFAULT NULL,
  `fault_code2` int DEFAULT NULL,
  `fault_code1` int DEFAULT NULL,
  `fault_value` float DEFAULT NULL,
  `warning_value2` float DEFAULT NULL,
  `warning_value1` float DEFAULT NULL,
  `warning_value3` float DEFAULT NULL,
  `fault_type` int DEFAULT NULL,
  `pto_status` int DEFAULT NULL,
  `bdc_status` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `growatt_server_status`
--

DROP TABLE IF EXISTS `growatt_server_status`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `growatt_server_status` (
  `id` int NOT NULL,
  `last_successful_api_call` datetime DEFAULT NULL,
  `last_api_status` varchar(10) DEFAULT NULL,
  `recovery_grace_period_until` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `monthly_generation`
--

DROP TABLE IF EXISTS `monthly_generation`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `monthly_generation` (
  `plant_name` varchar(100) NOT NULL,
  `inverter_id` varchar(50) NOT NULL,
  `year` smallint NOT NULL,
  `month` tinyint NOT NULL,
  `gen_kwh` decimal(12,2) DEFAULT NULL,
  `last_updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`plant_name`,`inverter_id`,`year`,`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `plant_config`
--

DROP TABLE IF EXISTS `plant_config`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plant_config` (
  `plant_name` varchar(50) NOT NULL,
  `inverter_id` varchar(20) NOT NULL,
  `string_grouping_type` varchar(30) DEFAULT NULL,
  `active_strings_config` json DEFAULT NULL,
  `api_type` varchar(50) NOT NULL DEFAULT 'Growatt',
  PRIMARY KEY (`plant_name`,`inverter_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `plant_info`
--

DROP TABLE IF EXISTS `plant_info`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plant_info` (
  `plant_name` varchar(255) NOT NULL,
  `uc` varchar(50) DEFAULT NULL,
  `owner_name` varchar(255) DEFAULT NULL,
  `owner_whatsapp` varchar(50) DEFAULT NULL,
  `owner_chat_id` bigint DEFAULT NULL,
  `owner_email` varchar(255) DEFAULT NULL,
  `owner_doc` varchar(50) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`plant_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `solar_data`
--

DROP TABLE IF EXISTS `solar_data`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `solar_data` (
  `id` int NOT NULL AUTO_INCREMENT,
  `plant_name` varchar(50) NOT NULL,
  `inverter_id` varchar(20) NOT NULL,
  `bdc_status` int DEFAULT NULL,
  `device_model` varchar(50) DEFAULT NULL,
  `gen_today` decimal(10,2) DEFAULT NULL,
  `gen_total` decimal(10,2) DEFAULT NULL,
  `epv1_today` decimal(10,2) DEFAULT NULL,
  `epv2_today` decimal(10,2) DEFAULT NULL,
  `epv3_today` decimal(10,2) DEFAULT NULL,
  `epv4_today` decimal(10,2) DEFAULT NULL,
  `epv5_today` decimal(10,2) DEFAULT NULL,
  `epv6_today` decimal(10,2) DEFAULT NULL,
  `epv7_today` decimal(10,2) DEFAULT NULL,
  `epv8_today` decimal(10,2) DEFAULT NULL,
  `current_mppt1` decimal(10,2) DEFAULT NULL,
  `current_mppt2` decimal(10,2) DEFAULT NULL,
  `current_mppt3` decimal(10,2) DEFAULT NULL,
  `current_mppt4` decimal(10,2) DEFAULT NULL,
  `current_mppt5` decimal(10,2) DEFAULT NULL,
  `current_mppt6` decimal(10,2) DEFAULT NULL,
  `current_mppt7` decimal(10,2) DEFAULT NULL,
  `current_mppt8` decimal(10,2) DEFAULT NULL,
  `last_update_time` datetime DEFAULT NULL,
  `pto_status` int DEFAULT NULL,
  `status` int DEFAULT NULL,
  `temperature` decimal(10,2) DEFAULT NULL,
  `temperature2` decimal(10,2) DEFAULT NULL,
  `temperature3` decimal(10,2) DEFAULT NULL,
  `temperature5` decimal(10,2) DEFAULT NULL,
  `update_status` int DEFAULT NULL,
  `voltage_ac1` decimal(10,2) DEFAULT NULL,
  `voltage_ac2` decimal(10,2) DEFAULT NULL,
  `voltage_ac3` decimal(10,2) DEFAULT NULL,
  `voltage_mppt1` decimal(10,2) DEFAULT NULL,
  `voltage_mppt2` decimal(10,2) DEFAULT NULL,
  `voltage_mppt3` decimal(10,2) DEFAULT NULL,
  `voltage_mppt4` decimal(10,2) DEFAULT NULL,
  `voltage_mppt5` decimal(10,2) DEFAULT NULL,
  `voltage_mppt6` decimal(10,2) DEFAULT NULL,
  `voltage_mppt7` decimal(10,2) DEFAULT NULL,
  `voltage_mppt8` decimal(10,2) DEFAULT NULL,
  `warn_code` int DEFAULT NULL,
  `pid_fault_code` int DEFAULT NULL,
  `warn_bit` int DEFAULT NULL,
  `warn_code1` int DEFAULT NULL,
  `fault_code2` int DEFAULT NULL,
  `fault_code1` int DEFAULT NULL,
  `fault_value` int DEFAULT NULL,
  `warning_value2` decimal(10,2) DEFAULT NULL,
  `warning_value1` decimal(10,2) DEFAULT NULL,
  `warning_value3` decimal(10,2) DEFAULT NULL,
  `fault_type` int DEFAULT NULL,
  `current_string1` decimal(10,2) DEFAULT NULL,
  `current_string2` decimal(10,2) DEFAULT NULL,
  `current_string3` decimal(10,2) DEFAULT NULL,
  `current_string4` decimal(10,2) DEFAULT NULL,
  `current_string5` decimal(10,2) DEFAULT NULL,
  `current_string6` decimal(10,2) DEFAULT NULL,
  `current_string7` decimal(10,2) DEFAULT NULL,
  `current_string8` decimal(10,2) DEFAULT NULL,
  `current_string9` decimal(10,2) DEFAULT NULL,
  `current_string10` decimal(10,2) DEFAULT NULL,
  `current_string11` decimal(10,2) DEFAULT NULL,
  `current_string12` decimal(10,2) DEFAULT NULL,
  `current_string13` decimal(10,2) DEFAULT NULL,
  `current_string14` decimal(10,2) DEFAULT NULL,
  `current_string15` decimal(10,2) DEFAULT NULL,
  `current_string16` decimal(10,2) DEFAULT NULL,
  `nominal_power` decimal(10,2) DEFAULT NULL,
  `frequency_ac` decimal(10,2) DEFAULT NULL,
  `output_power` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uc_inverter_time` (`inverter_id`,`last_update_time`),
  KEY `idx_plant_name` (`plant_name`),
  KEY `idx_inverter_last_update` (`inverter_id`,`last_update_time` DESC),
  KEY `idx_last_update_time` (`last_update_time`)
) ENGINE=InnoDB AUTO_INCREMENT=27735 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
